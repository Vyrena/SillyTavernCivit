import crypto from 'node:crypto';
import path from 'node:path';

import express from 'express';
import fetch from 'node-fetch';
import mime from 'mime-types';

import {
    buildCivitaiWorkflow,
    CIVITAI_BUILTIN_MODELS,
    CIVITAI_TERMINAL_STATUSES,
    flattenCivitaiLoras,
    flattenCivitaiModels,
    getCivitaiPromptEnhancement,
    getCivitaiBuiltinModel,
    getCivitaiWorkflowError,
    getCivitaiWorkflowImages,
    parseCivitaiAir,
    parseCivitaiLoras,
    parseCivitaiModelReference,
} from '../civitai.js';
import { readSecret, SECRET_KEYS } from './secrets.js';

const SITE_API = 'https://civitai.com/api/v1';
const ORCHESTRATION_API = 'https://orchestration.civitai.com/v2/consumer';
const MAX_LORAS = 10;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 192 * 1024 * 1024;
const MAX_SOURCE_IMAGE_LENGTH = 32 * 1024 * 1024;
const MAX_RETRY_ATTEMPTS = 5;
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
        const data = await searchCivitaiResources(token, request.body, 'Checkpoint');
        return response.send([...CIVITAI_BUILTIN_MODELS, ...flattenCivitaiModels(data)]);
    } catch (error) {
        return sendCivitaiError(response, error);
    }
});

router.post('/loras', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const data = await searchCivitaiResources(token, request.body, 'LORA');
        return response.send(flattenCivitaiLoras(data));
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

router.post('/enhance', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const model = await resolveCivitaiResource(token, request.body?.model, 'checkpoint');
        ensureSupportedEcosystem(model);
        const prompt = String(request.body?.prompt || '').trim().slice(0, 10000);
        const negativePrompt = String(request.body?.negative_prompt || '').trim().slice(0, 10000);
        if (!prompt) {
            throw new CivitaiApiError('A prompt is required for Civitai prompt review.', 400);
        }

        const workflow = {
            steps: [{
                $type: 'promptEnhancement',
                name: 'enhance',
                input: {
                    ecosystem: model.ecosystem,
                    prompt,
                    ...(negativePrompt ? { negativePrompt } : {}),
                },
            }],
            allowMatureContent: Boolean(request.body?.allow_mature),
            tags: ['sillytavern', 'prompt-enhancement'],
            metadata: {
                client: 'SillyTavern',
                source: 'native-image-generation',
                kind: 'prompt-enhancement',
            },
            externalId: `sillytavern-enhance-${crypto.randomUUID()}`,
        };
        const result = await submitWorkflow(token, workflow, false);
        ensureWorkflowId(result);
        return response.send(summarizeWorkflow(result));
    } catch (error) {
        return sendCivitaiError(response, error);
    }
});

router.post('/preview', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const workflow = await prepareWorkflow(token, request.body, 'preview');
        const result = await submitWorkflow(token, workflow, true);
        return response.send(summarizeWorkflow(result));
    } catch (error) {
        return sendCivitaiError(response, error);
    }
});

router.post('/generate', async (request, response) => {
    try {
        const token = getCivitaiToken(request);
        const workflow = await prepareWorkflow(token, request.body, 'generate');
        const maximumCost = parseOptionalCost(request.body?.max_cost);

        if (maximumCost !== null) {
            const previewWorkflow = structuredClone(workflow);
            previewWorkflow.externalId = `sillytavern-guard-${crypto.randomUUID()}`;
            const preview = await submitWorkflow(token, previewWorkflow, true);
            enforceSpendingGuard(preview, maximumCost, Number(request.body?.budget_spent || 0), request.body?.confirm_over_max === true);
        }

        const result = await submitWorkflow(token, workflow, false);
        ensureWorkflowId(result);
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

        const images = getCivitaiWorkflowImages(workflow);
        if (images.length === 0) {
            if (summary.enhancement) {
                return response.send(summary);
            }
            throw new CivitaiApiError(getCivitaiWorkflowError(workflow), 502);
        }

        const downloaded = [];
        let totalBytes = 0;
        for (const image of images) {
            const result = await downloadCivitaiImage(image);
            totalBytes += result.bytes;
            if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
                throw new CivitaiApiError('The generated image batch is too large to download safely. Reduce quantity or disable upscaling.', 413);
            }
            downloaded.push({ id: image.id, format: result.format, image: result.image });
        }

        return response.send({
            ...summary,
            images: downloaded,
            format: downloaded[0]?.format || 'png',
            image: downloaded[0]?.image || '',
        });
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

async function searchCivitaiResources(token, body, type) {
    const query = String(body?.query || '').trim().slice(0, 200);
    const params = new URLSearchParams({
        limit: type === 'LORA' ? '30' : '50',
        types: type,
        supportsGeneration: 'true',
        sort: 'Most Downloaded',
        period: 'AllTime',
        primaryFileOnly: 'true',
        nsfw: String(body?.allow_mature === true),
    });

    if (query) {
        params.set('query', query);
    }
    const baseModel = String(body?.base_model || '').trim().slice(0, 100);
    if (type === 'LORA' && baseModel) {
        params.set('baseModels', baseModel);
    }

    return civitaiJson(`${SITE_API}/models?${params}`, token);
}

async function prepareWorkflow(token, body, purpose) {
    const model = await resolveCivitaiResource(token, body?.model, 'checkpoint');
    ensureSupportedEcosystem(model);

    const loraEntries = parseCivitaiLoras(body?.loras);
    if (loraEntries.length > MAX_LORAS) {
        throw new CivitaiApiError(`A maximum of ${MAX_LORAS} Civitai LoRAs can be used at once.`, 400);
    }

    const resolvedLoras = await Promise.all(loraEntries.map(async entry => {
        if (entry.strength < -4 || entry.strength > 4) {
            throw new CivitaiApiError(`LoRA strength ${entry.strength} is outside the supported -4 to 4 range.`, 400);
        }
        const resource = await resolveCivitaiResource(token, entry.reference, 'lora');
        if (resource.ecosystem !== model.ecosystem) {
            throw new CivitaiApiError(`LoRA ${resource.name} uses ${resource.ecosystem}, but the checkpoint uses ${model.ecosystem}.`, 400);
        }
        return { ...resource, strength: entry.strength };
    }));

    const sourceImage = String(body?.source_image || '').trim();
    if (sourceImage.length > MAX_SOURCE_IMAGE_LENGTH) {
        throw new CivitaiApiError('The image-to-image source is too large. Use an image under about 24 MB.', 413);
    }

    const seedValue = Number(body?.seed);
    const seed = Number.isSafeInteger(seedValue) && seedValue >= 0 && seedValue <= 0xFFFFFFFF
        ? seedValue
        : crypto.randomInt(0, 0x100000000);
    const prompt = String(body?.prompt ?? '').slice(0, 10000);
    const negativePrompt = String(body?.negative_prompt || '').slice(0, 10000);
    const postProcess = String(body?.post_process || 'none');
    const quantity = Number(body?.quantity ?? 1);

    const workflow = buildCivitaiWorkflow({
        model: model.air,
        ecosystem: model.ecosystem,
        prompt,
        negativePrompt,
        width: Number(body?.width),
        height: Number(body?.height),
        steps: Number(body?.steps),
        cfgScale: Number(body?.cfg_scale),
        sampler: String(body?.sampler || ''),
        scheduler: String(body?.scheduler || ''),
        clipSkip: Number(body?.clip_skip),
        seed,
        quantity,
        kreaVariant: model.variant || String(body?.krea_variant || 'raw'),
        sourceImage,
        strength: Number(body?.source_strength ?? 0.7),
        postProcess,
        loras: Object.fromEntries(resolvedLoras.map(resource => [resource.air, resource.strength])),
        enhancePrompt: body?.enhance_prompt === true,
        allowMatureContent: body?.allow_mature === true,
        externalId: `sillytavern-${purpose}-${crypto.randomUUID()}`,
    });

    const warnings = [...model.warnings, ...resolvedLoras.flatMap(resource => resource.warnings)];
    if (model.ecosystem === 'krea2' && sourceImage) {
        warnings.push('Krea 2 uses instruction-based Edit mode for source images; the strength slider is not used and Edit supports up to 4 outputs.');
    }
    workflow.metadata.generation = {
        model: pickResourceMetadata(model),
        loras: resolvedLoras.map(resource => ({ ...pickResourceMetadata(resource), strength: resource.strength })),
        prompt,
        negativePrompt,
        width: Number(body?.width),
        height: Number(body?.height),
        steps: Number(body?.steps),
        cfgScale: Number(body?.cfg_scale),
        sampler: String(body?.sampler || ''),
        scheduler: String(body?.scheduler || ''),
        clipSkip: Number(body?.clip_skip),
        seed,
        quantity,
        kreaVariant: model.variant || String(body?.krea_variant || 'raw'),
        promptMode: body?.enhance_prompt === true ? 'automatic' : 'off',
        allowMature: body?.allow_mature === true,
        source: sourceImage
            ? {
                enabled: true,
                mode: model.ecosystem === 'krea2' ? 'edit' : 'variant',
                strength: model.ecosystem === 'krea2' ? null : Number(body?.source_strength ?? 0.7),
            }
            : { enabled: false },
        postProcess,
        warnings,
    };

    return workflow;
}

async function resolveCivitaiResource(token, reference, expectedType) {
    const builtin = getCivitaiBuiltinModel(reference);
    if (builtin) {
        if (expectedType !== 'checkpoint') {
            throw new CivitaiApiError(`Expected a Civitai ${expectedType}, but ${builtin.name} is a managed generation model.`, 400);
        }
        return {
            air: builtin.value,
            reference: builtin.value,
            name: builtin.name,
            ecosystem: builtin.ecosystem,
            type: 'builtin',
            modelId: null,
            versionId: null,
            baseModel: builtin.baseModel,
            availability: 'Managed',
            canGenerate: true,
            checkPermission: false,
            earlyAccessEndsAt: null,
            freeTrialLimit: null,
            additionalResourceCharge: false,
            sfwOnly: false,
            variant: builtin.variant,
            builtin: true,
            warnings: [],
        };
    }

    const parsed = parseCivitaiModelReference(reference);
    let versionId = parsed.versionId;

    if (!versionId && parsed.modelId) {
        const model = await civitaiJson(`${SITE_API}/models/${parsed.modelId}`, token);
        const versions = Array.isArray(model?.modelVersions) ? model.modelVersions : [];
        const version = versions.find(item => item?.supportsGeneration === true)
            ?? versions.find(item => item?.supportsGeneration !== false);
        versionId = Number(version?.id);
        if (!Number.isSafeInteger(versionId)) {
            throw new CivitaiApiError('That Civitai model has no generation-capable model version.', 400);
        }
    }

    if (!Number.isSafeInteger(versionId) || versionId <= 0) {
        throw new CivitaiApiError('Invalid Civitai model version ID.', 400);
    }

    const version = await civitaiJson(`${SITE_API}/model-versions/mini/${versionId}`, token);
    const resource = validateResolvedResource({
        air: String(version?.air || ''),
        name: `${String(version?.modelName || `Model ${parsed.modelId || ''}`)} — ${String(version?.versionName || `Version ${versionId}`)}`,
        modelId: parsed.modelId,
        versionId,
        baseModel: String(version?.baseModel || ''),
        availability: String(version?.availability || ''),
        canGenerate: version?.canGenerate,
        checkPermission: version?.checkPermission === true,
        earlyAccessEndsAt: version?.earlyAccessEndsAt || null,
        freeTrialLimit: version?.freeTrialLimit ?? null,
        additionalResourceCharge: version?.additionalResourceCharge === true,
        sfwOnly: version?.sfwOnly === true,
    }, expectedType);

    const pastedAir = parsed.air ? parseCivitaiAir(parsed.air) : null;
    if (pastedAir && (
        pastedAir.ecosystem !== resource.ecosystem
        || pastedAir.type !== resource.type
        || pastedAir.modelId !== resource.modelId
        || pastedAir.versionId !== resource.versionId
    )) {
        throw new CivitaiApiError('The pasted AIR does not match the canonical AIR returned by Civitai.', 400);
    }
    if (resource.canGenerate === false) {
        const access = resource.checkPermission
            ? ` Generation permission is required${resource.earlyAccessEndsAt ? ` until ${resource.earlyAccessEndsAt}` : ''}.`
            : '';
        throw new CivitaiApiError(`${resource.name} cannot currently be used for Civitai generation.${access}`, 400);
    }

    const warnings = [];
    if (resource.checkPermission) {
        warnings.push(resource.earlyAccessEndsAt
            ? `Generation permission verified; early access ends ${resource.earlyAccessEndsAt}.`
            : 'Generation permission verified for this gated resource.');
    }
    if (resource.additionalResourceCharge) {
        warnings.push('This resource adds an extra Buzz charge.');
    }
    if (resource.freeTrialLimit !== null && resource.freeTrialLimit !== undefined && Number.isFinite(Number(resource.freeTrialLimit))) {
        warnings.push(`This gated resource reports a ${Number(resource.freeTrialLimit)}-generation free-trial limit.`);
    }
    if (resource.sfwOnly) {
        warnings.push('This resource is restricted to SFW generation.');
    }
    if (resource.canGenerate === undefined) {
        warnings.push('Civitai did not report generation capability; the workflow preview will perform the final check.');
    }

    return { ...resource, warnings };
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

function ensureSupportedEcosystem(resource) {
    if (!['sd1', 'sdxl', 'krea2'].includes(resource.ecosystem)) {
        throw new CivitaiApiError(`Civitai model ${resource.name} uses the unsupported ${resource.ecosystem} ecosystem. Select an SD1, SDXL, or Krea 2 model.`, 400);
    }
}

function pickResourceMetadata(resource) {
    return {
        air: resource.air,
        name: resource.name,
        ecosystem: resource.ecosystem,
        type: resource.type,
        modelId: resource.modelId,
        versionId: resource.versionId,
        baseModel: resource.baseModel,
        availability: resource.availability,
        reference: resource.reference || resource.air,
        builtin: resource.builtin === true,
        variant: resource.variant || null,
        checkPermission: resource.checkPermission,
        earlyAccessEndsAt: resource.earlyAccessEndsAt,
        freeTrialLimit: resource.freeTrialLimit,
        additionalResourceCharge: resource.additionalResourceCharge,
        sfwOnly: resource.sfwOnly,
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
    const metadata = workflow?.metadata?.generation ?? null;
    return {
        id: String(workflow?.id || ''),
        status,
        terminal: CIVITAI_TERMINAL_STATUSES.has(status),
        cost: workflow?.cost ?? null,
        transactions: workflow?.transactions ?? null,
        enhancement: getCivitaiPromptEnhancement(workflow),
        metadata,
        warnings: Array.isArray(metadata?.warnings) ? metadata.warnings : [],
        progress: summarizeProgress(workflow),
        createdAt: workflow?.createdAt ?? null,
        completedAt: workflow?.completedAt ?? null,
        error: status === 'succeeded' ? null : (CIVITAI_TERMINAL_STATUSES.has(status) ? getCivitaiWorkflowError(workflow) : null),
    };
}

function summarizeProgress(workflow) {
    const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
    const relevant = steps.filter(step => !CIVITAI_TERMINAL_STATUSES.has(String(step?.status || '')) || step?.status === 'failed');
    const current = relevant[0] ?? steps.at(-1) ?? null;
    const rates = steps.map(step => {
        const stepRate = Number(step?.estimatedProgressRate);
        const jobRates = Array.isArray(step?.jobs)
            ? step.jobs.map(job => Number(job?.estimatedProgressRate)).filter(Number.isFinite)
            : [];
        return Number.isFinite(stepRate) ? stepRate : (jobRates.length ? Math.max(...jobRates) : (step?.status === 'succeeded' ? 1 : 0));
    });
    const queuePositions = steps.flatMap(step => Array.isArray(step?.jobs) ? step.jobs : [])
        .map(job => Number(job?.queuePosition))
        .filter(position => Number.isFinite(position) && position >= 0);
    const rate = rates.length ? rates.reduce((total, value) => total + value, 0) / rates.length : 0;

    return {
        status: String(current?.status || workflow?.status || 'unassigned'),
        step: String(current?.name || current?.$type || ''),
        rate: Math.max(0, Math.min(1, rate)),
        queuePosition: queuePositions.length ? Math.min(...queuePositions) : null,
    };
}

function enforceSpendingGuard(preview, maximumCost, budgetSpent, confirmed) {
    if (preview?.transactions?.insufficientBuzz === true) {
        throw new CivitaiApiError('Civitai reports insufficient Buzz for this workflow. Add Buzz or reduce the generation cost.', 402);
    }

    const total = Number(preview?.cost?.total);
    const alreadySpent = Number.isFinite(budgetSpent) && budgetSpent > 0 ? budgetSpent : 0;
    if (!Number.isFinite(total)) {
        throw new CivitaiApiError('Civitai did not return a usable cost estimate, so the spending limit blocked this generation.', 502);
    }
    if (total + alreadySpent > maximumCost && !confirmed) {
        throw new CivitaiApiError(`Civitai estimates ${total + alreadySpent} Buzz, above your ${maximumCost} Buzz confirmation limit.`, 402);
    }
}

function parseOptionalCost(value) {
    if (value === undefined || value === null || value === '' || Number(value) <= 0) {
        return null;
    }
    const cost = Number(value);
    if (!Number.isFinite(cost) || cost > 1000000) {
        throw new CivitaiApiError('Maximum Civitai cost must be a positive number no greater than 1,000,000 Buzz.', 400);
    }
    return cost;
}

async function downloadCivitaiImage(image) {
    let imageUrl;
    try {
        imageUrl = new URL(image.url);
    } catch {
        throw new CivitaiApiError('Civitai returned an invalid generated-image URL.', 502);
    }
    if (imageUrl.protocol !== 'https:') {
        throw new CivitaiApiError('Civitai returned an insecure generated-image URL.', 502);
    }

    const imageResponse = await fetchWithRetry(imageUrl, {
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
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new CivitaiApiError('A generated image exceeded the 64 MB download limit.', 413);
    }
    const pathExtension = path.extname(imageUrl.pathname).slice(1).toLowerCase();
    const format = mimeExtension || (SAFE_IMAGE_FORMATS.has(pathExtension) ? pathExtension : 'png');
    return { format, image: buffer.toString('base64'), bytes: buffer.length };
}

function ensureWorkflowId(workflow) {
    if (!workflow?.id) {
        throw new CivitaiApiError('Civitai accepted the request but did not return a workflow ID.');
    }
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
    return fetchWithRetry(url, {
        ...options,
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
        },
    });
}

async function fetchWithRetry(url, options = {}) {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(url, options);
            if (response.status !== 429 && response.status < 500) {
                return response;
            }
            if (attempt === MAX_RETRY_ATTEMPTS - 1) {
                return response;
            }

            const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
            await response.arrayBuffer().catch(() => undefined);
            await waitForRetry(retryAfter ?? retryDelay(attempt));
        } catch (error) {
            lastError = error;
            if (attempt === MAX_RETRY_ATTEMPTS - 1) {
                throw error;
            }
            await waitForRetry(retryDelay(attempt));
        }
    }
    throw lastError ?? new CivitaiApiError('Civitai request failed after retries.', 502);
}

function retryDelay(attempt) {
    const exponential = Math.min(30000, 1000 * (2 ** attempt));
    return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

function parseRetryAfter(value) {
    if (!value) {
        return null;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return Math.min(30000, Math.max(0, seconds * 1000));
    }
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.min(30000, Math.max(0, date - Date.now())) : null;
}

function waitForRetry(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
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
