import crypto from 'node:crypto';
import path from 'node:path';

import express from 'express';
import fetch from 'node-fetch';
import mime from 'mime-types';

import {
    buildCivitaiWorkflow,
    CIVITAI_TERMINAL_STATUSES,
    flattenCivitaiModels,
    getCivitaiPromptEnhancement,
    getCivitaiWorkflowError,
    getCivitaiWorkflowImage,
    parseCivitaiAir,
    parseCivitaiLoras,
    parseCivitaiModelReference,
} from '../civitai.js';
import { readSecret, SECRET_KEYS } from './secrets.js';

const SITE_API = 'https://civitai.com/api/v1';
const ORCHESTRATION_API = 'https://orchestration.civitai.com/v2/consumer';
const MAX_LORAS = 10;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const SAFE_IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif']);

class CivitaiApiError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.name = 'CivitaiApiError';
        this.status = status;
    }
}

export const router = express.Router();

router.post('/models', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const query = String(request.body?.query || '').trim().slice(0, 200);
        const params = new URLSearchParams({
            limit: '50',
            types: 'Checkpoint',
            supportsGeneration: 'true',
            sort: 'Most Downloaded',
            period: 'AllTime',
            primaryFileOnly: 'true',
            nsfw: String(request.body?.allow_mature === true),
        });

        if (query) {
            params.set('query', query);
        }

        const data = await civitaiJson(`${SITE_API}/models?${params}`, token);
        return response.send(flattenCivitaiModels(data));
    } catch (error) {
        return sendCivitaiError(response, error);
    }
});

router.post('/resolve', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const resource = await resolveCivitaiResource(token, request.body?.model, 'checkpoint');
        return response.send(resource);
    } catch (error) {
        return sendCivitaiError(response, error);
    }
});

router.post('/preview', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const workflow = await prepareWorkflow(token, request.body, 'preview');
        const result = await submitWorkflow(token, workflow, true);
        return response.send({ cost: result?.cost ?? null, status: result?.status ?? 'unassigned' });
    } catch (error) {
        return sendCivitaiError(response, error);
    }
});

router.post('/generate', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const workflow = await prepareWorkflow(token, request.body, 'generate');
        const result = await submitWorkflow(token, workflow, false);

        if (!result?.id) {
            throw new CivitaiApiError('Civitai accepted the request but did not return a workflow ID.');
        }

        return response.send(summarizeWorkflow(result));
    } catch (error) {
        return sendCivitaiError(response, error);
    }
});

router.post('/status', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const workflowId = validateWorkflowId(request.body?.id);
        const workflow = await civitaiJson(`${ORCHESTRATION_API}/workflows/${encodeURIComponent(workflowId)}`, token);
        const summary = summarizeWorkflow(workflow);

        if (workflow?.status !== 'succeeded') {
            return response.send(summary);
        }

        const image = getCivitaiWorkflowImage(workflow);
        if (!image) {
            throw new CivitaiApiError(getCivitaiWorkflowError(workflow), 502);
        }

        let imageUrl;
        try {
            imageUrl = new URL(image.url);
        } catch {
            throw new CivitaiApiError('Civitai returned an invalid generated-image URL.', 502);
        }
        if (imageUrl.protocol !== 'https:') {
            throw new CivitaiApiError('Civitai returned an insecure generated-image URL.', 502);
        }

        const imageResponse = await fetch(imageUrl, {
            method: 'GET',
            headers: { 'Accept': 'image/*' },
            size: MAX_IMAGE_BYTES,
        });
        if (!imageResponse.ok) {
            throw new CivitaiApiError(`Could not download the generated image from Civitai (${imageResponse.status}).`, 502);
        }

        const contentType = String(imageResponse.headers.get('content-type') || '').split(';')[0].toLowerCase();
        const mimeExtension = contentType ? mime.extension(contentType) : false;
        if (contentType && (!mimeExtension || !SAFE_IMAGE_FORMATS.has(mimeExtension))) {
            throw new CivitaiApiError(`Civitai returned an unexpected generated-image content type (${contentType}).`, 502);
        }

        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        const pathExtension = path.extname(imageUrl.pathname).slice(1).toLowerCase();
        const extension = mimeExtension || (SAFE_IMAGE_FORMATS.has(pathExtension) ? pathExtension : 'png');
        return response.send({ ...summary, format: extension, image: buffer.toString('base64') });
    } catch (error) {
        return sendCivitaiError(response, error);
    }
});

router.post('/cancel', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const workflowId = validateWorkflowId(request.body?.id);
        const result = await civitaiFetch(`${ORCHESTRATION_API}/workflows/${encodeURIComponent(workflowId)}`, token, {
            method: 'DELETE',
        });

        if (result.status === 404 || result.status === 204) {
            return response.send({ id: workflowId, status: 'canceled' });
        }
        if (!result.ok) {
            throw await makeCivitaiApiError(result);
        }
        return response.send({ id: workflowId, status: 'canceled' });
    } catch (error) {
        return sendCivitaiError(response, error);
    }
});

async function prepareWorkflow(token, body, purpose) {
    const model = await resolveCivitaiResource(token, body?.model, 'checkpoint');
    if (!['sd1', 'sdxl'].includes(model.ecosystem)) {
        throw new CivitaiApiError(`Civitai model ${model.name} uses the unsupported ${model.ecosystem} ecosystem. Select an SD1 or SDXL checkpoint.`, 400);
    }

    const loraEntries = parseCivitaiLoras(body?.loras);
    if (loraEntries.length > MAX_LORAS) {
        throw new CivitaiApiError(`A maximum of ${MAX_LORAS} Civitai LoRAs can be used at once.`, 400);
    }

    const resolvedLoras = await Promise.all(loraEntries.map(async entry => {
        const resource = await resolveCivitaiResource(token, entry.reference, 'lora');
        if (resource.ecosystem !== model.ecosystem) {
            throw new CivitaiApiError(`LoRA ${resource.name} uses ${resource.ecosystem}, but the checkpoint uses ${model.ecosystem}.`, 400);
        }
        return [resource.air, entry.strength];
    }));

    return buildCivitaiWorkflow({
        model: model.air,
        ecosystem: model.ecosystem,
        prompt: body?.prompt ?? '',
        negativePrompt: body?.negative_prompt || '',
        width: Number(body?.width),
        height: Number(body?.height),
        steps: Number(body?.steps),
        cfgScale: Number(body?.cfg_scale),
        sampler: String(body?.sampler || ''),
        scheduler: String(body?.scheduler || ''),
        clipSkip: Number(body?.clip_skip),
        seed: body?.seed === undefined ? undefined : Number(body.seed),
        loras: Object.fromEntries(resolvedLoras),
        enhancePrompt: body?.enhance_prompt === true,
        allowMatureContent: body?.allow_mature === true,
        // Never reuse a what-if external ID for a real submission.
        externalId: `sillytavern-${purpose}-${crypto.randomUUID()}`,
    });
}

async function resolveCivitaiResource(token, reference, expectedType) {
    const parsed = parseCivitaiModelReference(reference);
    if (parsed.air) {
        return validateResolvedResource({ air: parsed.air, name: parsed.air }, expectedType);
    }

    let versionId = parsed.versionId;
    if (!versionId && parsed.modelId) {
        const model = await civitaiJson(`${SITE_API}/models/${parsed.modelId}`, token);
        const versions = Array.isArray(model?.modelVersions) ? model.modelVersions : [];
        const version = versions.find(item => item?.supportsGeneration === true)
            ?? versions.find(item => item?.supportsGeneration !== false);
        versionId = Number(version?.id);
        if (!Number.isSafeInteger(versionId)) {
            throw new CivitaiApiError('That Civitai model has no available model version.', 400);
        }
    }

    if (!Number.isSafeInteger(versionId) || versionId <= 0) {
        throw new CivitaiApiError('Invalid Civitai model version ID.', 400);
    }

    const version = await civitaiJson(`${SITE_API}/model-versions/${versionId}`, token);
    const resource = {
        air: String(version?.air || ''),
        name: `${String(version?.model?.name || `Model ${version?.modelId || ''}`)} — ${String(version?.name || `Version ${versionId}`)}`,
        modelId: Number(version?.modelId),
        versionId: Number(version?.id),
        baseModel: String(version?.baseModel || ''),
    };
    return validateResolvedResource(resource, expectedType);
}

function validateResolvedResource(resource, expectedType) {
    const air = parseCivitaiAir(resource.air);
    if (!air) {
        throw new CivitaiApiError('Civitai did not return a canonical AIR for that resource.', 400);
    }
    if (air.type !== expectedType) {
        throw new CivitaiApiError(`Expected a Civitai ${expectedType}, but the resource is a ${air.type}.`, 400);
    }

    return {
        ...resource,
        air: air.air,
        ecosystem: air.ecosystem,
        type: air.type,
        modelId: resource.modelId || air.modelId,
        versionId: resource.versionId || air.versionId,
    };
}

async function submitWorkflow(token, workflow, whatif) {
    const params = new URLSearchParams({ whatif: String(whatif), wait: '0' });
    return civitaiJson(`${ORCHESTRATION_API}/workflows?${params}`, token, {
        method: 'POST',
        body: JSON.stringify(workflow),
    });
}

function summarizeWorkflow(workflow) {
    const status = String(workflow?.status || 'unassigned');
    return {
        id: String(workflow?.id || ''),
        status,
        terminal: CIVITAI_TERMINAL_STATUSES.has(status),
        cost: workflow?.cost ?? null,
        enhancement: getCivitaiPromptEnhancement(workflow),
        error: status === 'succeeded' ? null : (CIVITAI_TERMINAL_STATUSES.has(status) ? getCivitaiWorkflowError(workflow) : null),
    };
}

function getCivitaiToken(request) {
    const token = readSecret(request.user.directories, SECRET_KEYS.CIVITAI);
    if (!token) {
        throw new CivitaiApiError('Civitai API token is not configured.', 400);
    }
    return token;
}

function validateWorkflowId(value) {
    const id = String(value || '').trim();
    if (!/^[a-z0-9_-]{1,200}$/i.test(id)) {
        throw new CivitaiApiError('Invalid Civitai workflow ID.', 400);
    }
    return id;
}

async function civitaiJson(url, token, options = {}) {
    const result = await civitaiFetch(url, token, options);
    if (!result.ok) {
        throw await makeCivitaiApiError(result);
    }

    try {
        return await result.json();
    } catch {
        throw new CivitaiApiError('Civitai returned an invalid JSON response.', 502);
    }
}

function civitaiFetch(url, token, options = {}) {
    return fetch(url, {
        ...options,
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
        },
    });
}

async function makeCivitaiApiError(response) {
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = null;
    }

    const validation = data?.errors && typeof data.errors === 'object'
        ? Object.values(data.errors).flat().map(String).join(' ')
        : '';
    const message = data?.detail || data?.error || validation || data?.title || text || `Civitai request failed (${response.status}).`;
    return new CivitaiApiError(String(message).slice(0, 2000), response.status);
}

function sendCivitaiError(response, error) {
    const status = error instanceof CivitaiApiError
        ? (error.status >= 400 && error.status < 500 ? error.status : 502)
        : (error?.name === 'FetchError' ? 502 : 400);
    const message = error instanceof Error ? error.message : 'Unknown Civitai error.';
    console.warn('Civitai image generation error:', message);
    return response.status(status).send(message);
}
