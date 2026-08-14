const AIR_PATTERN = /^urn:air:([a-z0-9_\-/]+):([a-z0-9_\-/]+):civitai:(\d+)@(\d+)(?:\+\d+)?(?:\.[a-z0-9_-]+)?$/i;

export const CIVITAI_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);

export const CIVITAI_SAMPLERS = [
    'euler',
    'heun',
    'dpm2',
    'dpm++2s_a',
    'dpm++2m',
    'dpm++2mv2',
    'ipndm',
    'ipndm_v',
    'ddim_trailing',
    'euler_a',
    'lcm',
    'res_multistep',
    'res_2s',
    'tcd',
    'er_sde',
];

export const CIVITAI_SCHEDULES = [
    'discrete',
    'simple',
    'karras',
    'exponential',
    'ays',
    'bong_tangent',
    'gits',
    'sgm_uniform',
    'smoothstep',
    'kl_optimal',
    'lcm',
];

/**
 * Parse a model reference accepted by the Civitai UI.
 * @param {unknown} value Model version ID, model URL, model-version URL, or AIR.
 * @returns {{air?: string, modelId?: number, versionId?: number}}
 */
export function parseCivitaiModelReference(value) {
    const reference = String(value ?? '').trim();
    if (!reference) {
        throw new Error('Enter a Civitai model URL, model version ID, or AIR.');
    }

    const air = parseCivitaiAir(reference);
    if (air) {
        return { air: reference, modelId: air.modelId, versionId: air.versionId };
    }

    const internalVersion = reference.match(/^version:(\d+)$/i);
    if (internalVersion) {
        return { versionId: Number(internalVersion[1]) };
    }

    if (/^\d+$/.test(reference)) {
        return { versionId: Number(reference) };
    }

    let url;
    try {
        url = new URL(reference);
    } catch {
        throw new Error('Invalid Civitai model reference. Use a model URL, model version ID, or AIR.');
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'civitai.com' && hostname !== 'www.civitai.com') {
        throw new Error('Model URLs must use civitai.com.');
    }

    const queryVersionId = url.searchParams.get('modelVersionId');
    if (queryVersionId && /^\d+$/.test(queryVersionId)) {
        return { versionId: Number(queryVersionId) };
    }

    const versionPath = url.pathname.match(/\/(?:api\/v1\/)?model-versions\/(\d+)/i)
        ?? url.pathname.match(/\/api\/download\/models\/(\d+)/i);
    if (versionPath) {
        return { versionId: Number(versionPath[1]) };
    }

    const modelPath = url.pathname.match(/\/models\/(\d+)/i);
    if (modelPath) {
        return { modelId: Number(modelPath[1]) };
    }

    throw new Error('The Civitai URL does not identify a model or model version.');
}

/**
 * Parse a canonical Civitai AIR.
 * @param {unknown} value AIR value.
 * @returns {{air: string, ecosystem: string, type: string, modelId: number, versionId: number}|null}
 */
export function parseCivitaiAir(value) {
    const air = String(value ?? '').trim();
    const match = air.match(AIR_PATTERN);
    if (!match) {
        return null;
    }

    return {
        air,
        ecosystem: match[1].toLowerCase(),
        type: match[2].toLowerCase(),
        modelId: Number(match[3]),
        versionId: Number(match[4]),
    };
}

/**
 * Parse one LoRA per line in the form "reference = strength".
 * @param {unknown} value LoRA input.
 * @returns {{reference: string, strength: number}[]}
 */
export function parseCivitaiLoras(value) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return [];
    }

    return String(value)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            const separator = line.lastIndexOf('=');
            const reference = (separator === -1 ? line : line.slice(0, separator)).trim();
            const strengthText = separator === -1 ? '1' : line.slice(separator + 1).trim();
            const strength = Number(strengthText);

            if (!reference) {
                throw new Error(`LoRA line ${index + 1} is missing a model reference.`);
            }
            if (!Number.isFinite(strength)) {
                throw new Error(`LoRA line ${index + 1} has an invalid strength.`);
            }

            return { reference, strength };
        });
}

/**
 * Flatten Civitai model-search results for a select element.
 * @param {unknown} payload Civitai models response.
 * @returns {{value: string, text: string, modelId: number, versionId: number, baseModel: string}[]}
 */
export function flattenCivitaiModels(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const models = [];

    for (const model of items) {
        if (String(model?.type).toLowerCase() !== 'checkpoint' || model?.supportsGeneration === false) {
            continue;
        }

        const versions = Array.isArray(model?.modelVersions) ? model.modelVersions : [];
        for (const version of versions.filter(version => version?.supportsGeneration !== false).slice(0, 5)) {
            const versionId = Number(version?.id);
            const modelId = Number(model?.id);
            if (!Number.isSafeInteger(versionId) || !Number.isSafeInteger(modelId)) {
                continue;
            }

            const modelName = String(model?.name || `Model ${modelId}`);
            const versionName = String(version?.name || `Version ${versionId}`);
            const baseModel = String(version?.baseModel || 'Unknown base');
            models.push({
                value: `version:${versionId}`,
                text: `${modelName} — ${versionName} (${baseModel})`,
                modelId,
                versionId,
                baseModel,
            });
        }
    }

    return models;
}

/**
 * Build a Civitai image-generation workflow.
 * @param {object} params Image-generation parameters.
 * @param {string} params.model Canonical checkpoint AIR.
 * @param {string} params.ecosystem Civitai ecosystem.
 * @param {string} params.prompt Positive prompt.
 * @param {string} [params.negativePrompt] Negative prompt.
 * @param {number} params.width Image width.
 * @param {number} params.height Image height.
 * @param {number} params.steps Sampling steps.
 * @param {number} params.cfgScale CFG scale.
 * @param {string} [params.sampler] Sampling method.
 * @param {string} [params.scheduler] Schedule.
 * @param {number} [params.clipSkip] CLIP skip.
 * @param {number} [params.seed] Seed.
 * @param {Record<string, number>} [params.loras] LoRA AIRs and strengths.
 * @param {boolean} [params.allowMatureContent] Allow mature outputs.
 * @param {string} params.externalId Unique idempotency key.
 * @returns {object}
 */
export function buildCivitaiWorkflow(params) {
    const ecosystem = String(params.ecosystem || '').toLowerCase();
    if (!['sd1', 'sdxl'].includes(ecosystem)) {
        throw new Error(`Unsupported Civitai ecosystem "${ecosystem || 'unknown'}". This integration currently supports SD1 and SDXL checkpoints.`);
    }

    const modelAir = parseCivitaiAir(params.model);
    if (!modelAir || modelAir.type !== 'checkpoint') {
        throw new Error('The selected Civitai model is not a checkpoint AIR.');
    }
    if (modelAir.ecosystem !== ecosystem) {
        throw new Error(`The selected checkpoint belongs to ${modelAir.ecosystem}, not ${ecosystem}.`);
    }

    const width = validateInteger(params.width, 'Width', 64, 2048);
    const height = validateInteger(params.height, 'Height', 64, 2048);
    if (width % 16 !== 0 || height % 16 !== 0) {
        throw new Error('Civitai image width and height must be divisible by 16.');
    }

    const input = {
        engine: 'sdcpp',
        ecosystem,
        operation: 'createImage',
        model: params.model,
        prompt: String(params.prompt ?? '').slice(0, 10000),
        negativePrompt: String(params.negativePrompt ?? '').slice(0, 10000),
        width,
        height,
        cfgScale: validateNumber(params.cfgScale, 'CFG scale', 0, 30),
        steps: validateInteger(params.steps, 'Sampling steps', 1, 150),
        quantity: 1,
    };

    if (params.sampler && params.sampler !== 'N/A') {
        if (!CIVITAI_SAMPLERS.includes(params.sampler)) {
            throw new Error(`Unsupported Civitai sampler "${params.sampler}".`);
        }
        input.sampleMethod = params.sampler;
    }

    if (params.scheduler && params.scheduler !== 'N/A') {
        if (!CIVITAI_SCHEDULES.includes(params.scheduler)) {
            throw new Error(`Unsupported Civitai schedule "${params.scheduler}".`);
        }
        input.schedule = params.scheduler;
    }

    if (Number.isSafeInteger(params.seed) && params.seed >= 0) {
        input.seed = params.seed;
    }

    if (ecosystem === 'sd1' && Number.isSafeInteger(params.clipSkip)) {
        input.clipSkip = params.clipSkip;
    }

    if (params.loras && Object.keys(params.loras).length > 0) {
        input.loras = params.loras;
    }

    return {
        steps: [{ $type: 'imageGen', input }],
        allowMatureContent: Boolean(params.allowMatureContent),
        tags: ['sillytavern', 'image-generation'],
        metadata: { client: 'SillyTavern', source: 'native-image-generation' },
        externalId: params.externalId,
    };
}

/**
 * Extract the first deliverable image from a workflow.
 * @param {unknown} workflow Civitai workflow.
 * @returns {{url: string, id: string}|null}
 */
export function getCivitaiWorkflowImage(workflow) {
    const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
    for (const step of steps) {
        const images = Array.isArray(step?.output?.images) ? step.output.images : [];
        const image = images.find(item => item?.available !== false && typeof item?.url === 'string' && item.url);
        if (image) {
            return { url: image.url, id: String(image.id || '') };
        }
    }
    return null;
}

/**
 * Get a readable failure reason from a Civitai workflow.
 * @param {unknown} workflow Civitai workflow.
 * @returns {string}
 */
export function getCivitaiWorkflowError(workflow) {
    const messages = [];
    const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
    for (const step of steps) {
        if (Array.isArray(step?.output?.errors)) {
            messages.push(...step.output.errors.map(String));
        }
        if (Array.isArray(step?.jobs)) {
            messages.push(...step.jobs.map(job => job?.reason).filter(Boolean).map(String));
        }
        if (Array.isArray(step?.output?.images)) {
            messages.push(...step.output.images.map(image => image?.blockedReason).filter(Boolean).map(String));
        }
    }

    return messages.find(Boolean) || `Civitai workflow ${String(workflow?.status || 'failed')}.`;
}

function validateInteger(value, name, minimum, maximum) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    return number;
}

function validateNumber(value, name, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new Error(`${name} must be from ${minimum} to ${maximum}.`);
    }
    return number;
}
