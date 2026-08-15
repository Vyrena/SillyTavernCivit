const AIR_PATTERN = /^urn:air:([a-z0-9_\-/]+):([a-z0-9_\-/]+):civitai:(\d+)@(\d+)(?:\+\d+)?(?:\.[a-z0-9_-]+)?$/i;
const CIVITAI_HOST_PATTERN = /^(?:www\.)?civitai\.(?:com|red|green)$/i;

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

export const CIVITAI_BUILTIN_MODELS = [
    {
        value: 'krea2:raw',
        text: 'Krea 2 Raw — community LoRAs',
        name: 'Krea 2 Raw',
        ecosystem: 'krea2',
        variant: 'raw',
        baseModel: 'Krea 2',
        builtin: true,
    },
    {
        value: 'krea2:turbo',
        text: 'Krea 2 Turbo — community LoRAs',
        name: 'Krea 2 Turbo',
        ecosystem: 'krea2',
        variant: 'turbo',
        baseModel: 'Krea 2',
        builtin: true,
    },
];

const CIVITAI_COMFY_SAMPLERS = new Set([
    'euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpmpp_2s_ancestral', 'dpmpp_2m',
    'ipndm', 'ipndm_v', 'ddim', 'lcm', 'res_multistep', 'er_sde',
]);
const CIVITAI_COMFY_SAMPLER_ALIASES = {
    euler_a: 'euler_ancestral',
    dpm2: 'dpm_2',
    'dpm++2s_a': 'dpmpp_2s_ancestral',
    'dpm++2m': 'dpmpp_2m',
    'dpm++2mv2': 'dpmpp_2m',
    ddim_trailing: 'ddim',
};
const CIVITAI_COMFY_SCHEDULES = new Set(['normal', 'karras', 'exponential', 'sgm_uniform', 'simple']);
const CIVITAI_COMFY_SCHEDULE_ALIASES = { discrete: 'normal' };

/**
 * Resolve one of the integration's managed model references.
 * @param {unknown} value Model reference.
 * @returns {(typeof CIVITAI_BUILTIN_MODELS)[number]|null}
 */
export function getCivitaiBuiltinModel(value) {
    const reference = String(value ?? '').trim().toLowerCase();
    return CIVITAI_BUILTIN_MODELS.find(model => model.value === reference) ?? null;
}

/**
 * Check whether a canonical AIR can act as the selected base model.
 * Krea 2 publishes split diffusion weights as `diffusionmodel` resources,
 * while SD1/SDXL use traditional `checkpoint` resources.
 * @param {string} ecosystem Civitai ecosystem.
 * @param {string} type AIR resource type.
 * @returns {boolean}
 */
export function isCivitaiBaseModelType(ecosystem, type) {
    const normalizedEcosystem = String(ecosystem || '').toLowerCase();
    const normalizedType = String(type || '').toLowerCase();
    if (normalizedEcosystem === 'krea2') {
        return ['checkpoint', 'diffusionmodel'].includes(normalizedType);
    }
    return ['sd1', 'sdxl'].includes(normalizedEcosystem) && normalizedType === 'checkpoint';
}

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
    if (!CIVITAI_HOST_PATTERN.test(hostname)) {
        throw new Error('Model URLs must use an official civitai.com, civitai.red, or civitai.green domain.');
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
 * Flatten Civitai LoRA-search results for the Android-friendly browser.
 * @param {unknown} payload Civitai models response.
 * @returns {{value: string, text: string, modelId: number, versionId: number, baseModel: string, preview: string, trainedWords: string[]}[]}
 */
export function flattenCivitaiLoras(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const loras = [];

    for (const model of items) {
        if (String(model?.type).toLowerCase() !== 'lora' || model?.supportsGeneration === false) {
            continue;
        }

        const versions = Array.isArray(model?.modelVersions) ? model.modelVersions : [];
        for (const version of versions.filter(item => item?.supportsGeneration !== false).slice(0, 3)) {
            const versionId = Number(version?.id);
            const modelId = Number(model?.id);
            if (!Number.isSafeInteger(versionId) || !Number.isSafeInteger(modelId)) {
                continue;
            }

            const modelName = String(model?.name || `LoRA ${modelId}`);
            const versionName = String(version?.name || `Version ${versionId}`);
            const baseModel = String(version?.baseModel || 'Unknown base');
            const images = Array.isArray(version?.images) ? version.images : [];
            const preview = String(images.find(image => typeof image?.url === 'string')?.url || '');
            const trainedWords = Array.isArray(version?.trainedWords)
                ? version.trainedWords.map(String).map(word => word.trim()).filter(Boolean).slice(0, 20)
                : [];

            loras.push({
                value: `version:${versionId}`,
                text: `${modelName} — ${versionName}`,
                modelId,
                versionId,
                baseModel,
                preview,
                trainedWords,
            });
        }
    }

    return loras;
}

/**
 * Build a Civitai image-generation workflow.
 * @param {object} params Image-generation parameters.
 * @param {string} params.model Canonical base-model AIR or managed model reference.
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
 * @param {'raw'|'turbo'} [params.kreaVariant] Krea 2 generation variant for a custom diffusion model.
 * @param {number} [params.quantity] Number of images to generate.
 * @param {string} [params.sourceImage] Data URL, Base64 string, or public URL for img2img.
 * @param {number} [params.strength] Img2img denoising strength.
 * @param {'none'|'upscale'|'remove-background'} [params.postProcess] Optional finishing step.
 * @param {boolean} [params.enhancePrompt] Rewrite prompts with Civitai before generation.
 * @param {boolean} [params.allowMatureContent] Allow mature outputs.
 * @param {string} params.externalId Unique idempotency key.
 * @returns {object}
 */
export function buildCivitaiWorkflow(params) {
    const ecosystem = String(params.ecosystem || '').toLowerCase();
    if (!['sd1', 'sdxl', 'krea2'].includes(ecosystem)) {
        throw new Error(`Unsupported Civitai ecosystem "${ecosystem || 'unknown'}". This integration currently supports SD1, SDXL, and Krea 2.`);
    }

    const builtinModel = getCivitaiBuiltinModel(params.model);
    const modelAir = parseCivitaiAir(params.model);
    if (!builtinModel && (!modelAir || !isCivitaiBaseModelType(modelAir.ecosystem, modelAir.type))) {
        throw new Error('The selected Civitai resource is not a supported base-model AIR. Krea 2 accepts diffusionmodel or checkpoint AIRs; SD1/SDXL require checkpoints.');
    }
    if (builtinModel && builtinModel.ecosystem !== ecosystem) {
        throw new Error(`The selected managed model belongs to ${builtinModel.ecosystem}, not ${ecosystem}.`);
    }
    if (modelAir && modelAir.ecosystem !== ecosystem) {
        throw new Error(`The selected checkpoint belongs to ${modelAir.ecosystem}, not ${ecosystem}.`);
    }

    const width = validateInteger(params.width, 'Width', 64, 2048);
    const height = validateInteger(params.height, 'Height', 64, 2048);
    if (width % 16 !== 0 || height % 16 !== 0) {
        throw new Error('Civitai image width and height must be divisible by 16.');
    }

    const sourceImage = String(params.sourceImage || '').trim();
    const isKrea2 = ecosystem === 'krea2';
    const maximumQuantity = isKrea2 && sourceImage ? 4 : 12;
    const input = {
        prompt: String(params.prompt ?? '').slice(0, 10000),
        negativePrompt: String(params.negativePrompt ?? '').slice(0, 10000),
        width,
        height,
        cfgScale: validateNumber(params.cfgScale, 'CFG scale', 0, 30),
        steps: validateInteger(params.steps, 'Sampling steps', 1, 150),
        quantity: validateInteger(params.quantity ?? 1, 'Quantity', 1, maximumQuantity),
    };

    if (isKrea2) {
        const variant = builtinModel?.variant || String(params.kreaVariant || 'raw').toLowerCase();
        if (!['raw', 'turbo'].includes(variant)) {
            throw new Error(`Unsupported Krea 2 variant "${variant}".`);
        }

        input.engine = 'comfy';
        input.ecosystem = 'krea2';
        input.operation = 'createImage';
        input.model = variant;
        if (modelAir) {
            input.diffusionModel = modelAir.air;
        }
        if (params.sampler && params.sampler !== 'N/A') {
            input.sampler = mapCivitaiComfySampler(params.sampler);
        }
        if (params.scheduler && params.scheduler !== 'N/A') {
            input.scheduler = mapCivitaiComfySchedule(params.scheduler);
        }
    } else {
        input.engine = 'sdcpp';
        input.ecosystem = ecosystem;
        input.operation = 'createImage';
        input.model = modelAir.air;

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

    const imageStep = { $type: 'imageGen', name: 'generate', input };
    const steps = [];

    if (sourceImage) {
        steps.push({
            $type: 'convertImage',
            name: 'source-image',
            input: {
                image: sourceImage,
                output: { format: 'png', hideMetadata: true },
            },
        });
        const sourceReference = { $ref: 'source-image', path: 'output.blob.url' };
        if (isKrea2) {
            input.operation = 'editImage';
            input.model = 'edit';
            input.images = [sourceReference];
        } else {
            input.operation = 'createVariant';
            input.image = sourceReference;
            input.strength = validateNumber(params.strength ?? 0.7, 'Image-to-image strength', 0, 1);
        }
    }

    if (params.enhancePrompt) {
        const enhancementInput = {
            ecosystem,
            prompt: input.prompt,
        };

        if (input.negativePrompt) {
            enhancementInput.negativePrompt = input.negativePrompt;
        }

        steps.push({
            $type: 'promptEnhancement',
            name: 'enhance',
            input: enhancementInput,
        });
        input.prompt = { $ref: 'enhance', path: 'output.enhancedPrompt' };
        if (input.negativePrompt) {
            input.negativePrompt = { $ref: 'enhance', path: 'output.enhancedNegativePrompt' };
        }
    }

    steps.push(imageStep);

    const postProcess = String(params.postProcess || 'none');
    if (!['none', 'upscale', 'remove-background'].includes(postProcess)) {
        throw new Error(`Unsupported Civitai post-processing mode "${postProcess}".`);
    }

    if (postProcess !== 'none') {
        for (let index = 0; index < input.quantity; index++) {
            const imageReference = { $ref: 'generate', path: `output.images[${index}].url` };
            steps.push(postProcess === 'upscale'
                ? {
                    $type: 'imageUpscaler',
                    name: `post-${index}`,
                    input: { image: imageReference, numberOfRepeats: 1 },
                }
                : {
                    $type: 'imageBackgroundRemoval',
                    name: `post-${index}`,
                    input: { image: imageReference, format: 'png' },
                });
        }
    }

    return {
        steps,
        allowMatureContent: Boolean(params.allowMatureContent),
        tags: ['sillytavern', 'image-generation'],
        metadata: {
            client: 'SillyTavern',
            source: 'native-image-generation',
            outputStepNames: postProcess === 'none'
                ? ['generate']
                : Array.from({ length: input.quantity }, (_, index) => `post-${index}`),
        },
        externalId: params.externalId,
    };
}

/**
 * Extract all final deliverable images from a workflow.
 * @param {unknown} workflow Civitai workflow.
 * @returns {{url: string, id: string}[]}
 */
export function getCivitaiWorkflowImages(workflow) {
    const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
    const requestedNames = Array.isArray(workflow?.metadata?.outputStepNames)
        ? workflow.metadata.outputStepNames.map(String)
        : [];
    const outputSteps = requestedNames.length > 0
        ? requestedNames.map(name => steps.find(step => String(step?.name) === name)).filter(Boolean)
        : steps.filter(step => String(step?.name || '').startsWith('post-'));

    if (outputSteps.length > 0) {
        return outputSteps.flatMap(step => {
            const images = Array.isArray(step?.output?.images) ? step.output.images : [];
            const candidates = [step?.output?.blob, step?.output?.image]
                .filter(Boolean);
            return [...images, ...candidates]
                .filter(item => item?.available !== false && typeof item?.url === 'string' && item.url)
                .map(item => ({ url: item.url, id: String(item.id || '') }));
        });
    }

    const imageStep = steps.find(step => String(step?.name) === 'generate' && Array.isArray(step?.output?.images))
        ?? steps.find(step => Array.isArray(step?.output?.images));
    const images = Array.isArray(imageStep?.output?.images) ? imageStep.output.images : [];
    return images
        .filter(item => item?.available !== false && typeof item?.url === 'string' && item.url)
        .map(item => ({ url: item.url, id: String(item.id || '') }));
}

/**
 * Extract the first deliverable image from a workflow.
 * @param {unknown} workflow Civitai workflow.
 * @returns {{url: string, id: string}|null}
 */
export function getCivitaiWorkflowImage(workflow) {
    return getCivitaiWorkflowImages(workflow)[0] ?? null;
}

/**
 * Extract prompt-enhancement output from a workflow.
 * @param {unknown} workflow Civitai workflow.
 * @returns {{prompt: string, negativePrompt: string, issues: unknown[], recommendations: string[]}|null}
 */
export function getCivitaiPromptEnhancement(workflow) {
    const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
    const step = steps.find(item => item?.$type === 'promptEnhancement' && item?.output);
    const prompt = String(step?.output?.enhancedPrompt || '').trim();
    if (!prompt) {
        return null;
    }

    return {
        prompt,
        negativePrompt: String(step.output.enhancedNegativePrompt || '').trim(),
        issues: Array.isArray(step.output.issues) ? step.output.issues : [],
        recommendations: Array.isArray(step.output.recommendations) ? step.output.recommendations.map(String) : [],
    };
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

function mapCivitaiComfySampler(value) {
    const requested = String(value || '').trim();
    const sampler = CIVITAI_COMFY_SAMPLER_ALIASES[requested] || requested;
    if (!CIVITAI_COMFY_SAMPLERS.has(sampler)) {
        throw new Error(`Krea 2 does not support the Civitai sampler "${requested}". Try Euler, Euler A, DPM++ 2M, or LCM.`);
    }
    return sampler;
}

function mapCivitaiComfySchedule(value) {
    const requested = String(value || '').trim();
    const schedule = CIVITAI_COMFY_SCHEDULE_ALIASES[requested] || requested;
    if (!CIVITAI_COMFY_SCHEDULES.has(schedule)) {
        throw new Error(`Krea 2 does not support the Civitai schedule "${requested}". Try Discrete, Simple, Karras, Exponential, or SGM Uniform.`);
    }
    return schedule;
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
