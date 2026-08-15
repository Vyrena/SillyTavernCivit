import { describe, expect, test } from '@jest/globals';

import {
    buildCivitaiWorkflow,
    CIVITAI_BUILTIN_MODELS,
    flattenCivitaiLoras,
    flattenCivitaiModels,
    getCivitaiBuiltinModel,
    getCivitaiPromptEnhancement,
    getCivitaiWorkflowError,
    getCivitaiWorkflowImage,
    getCivitaiWorkflowImages,
    parseCivitaiAir,
    parseCivitaiLoras,
    parseCivitaiModelReference,
} from '../src/civitai.js';

const SD1_MODEL = 'urn:air:sd1:checkpoint:civitai:4384@128713';
const SDXL_MODEL = 'urn:air:sdxl:checkpoint:civitai:101055@128078';
const KREA2_MODEL = 'urn:air:krea2:checkpoint:civitai:30@40';

describe('parseCivitaiModelReference', () => {
    test('accepts version IDs and internal version values', () => {
        expect(parseCivitaiModelReference('128713')).toEqual({ versionId: 128713 });
        expect(parseCivitaiModelReference('version:128713')).toEqual({ versionId: 128713 });
    });

    test('accepts Civitai model and version URLs', () => {
        expect(parseCivitaiModelReference('https://civitai.com/models/4384?modelVersionId=128713')).toEqual({ versionId: 128713 });
        expect(parseCivitaiModelReference('https://civitai.com/api/v1/model-versions/128713')).toEqual({ versionId: 128713 });
        expect(parseCivitaiModelReference('https://civitai.com/models/4384')).toEqual({ modelId: 4384 });
    });

    test('accepts official Civitai red and green aliases', () => {
        expect(parseCivitaiModelReference('https://civitai.red/models/4384?modelVersionId=128713')).toEqual({ versionId: 128713 });
        expect(parseCivitaiModelReference('https://www.civitai.green/models/4384')).toEqual({ modelId: 4384 });
    });

    test('accepts canonical AIRs', () => {
        expect(parseCivitaiModelReference(SD1_MODEL)).toEqual({
            air: SD1_MODEL,
            modelId: 4384,
            versionId: 128713,
        });
    });

    test('rejects model URLs from other hosts', () => {
        expect(() => parseCivitaiModelReference('https://example.com/models/4384')).toThrow('civitai.com');
    });
});

describe('parseCivitaiAir', () => {
    test('extracts ecosystem, type, and IDs', () => {
        expect(parseCivitaiAir(SDXL_MODEL)).toMatchObject({
            ecosystem: 'sdxl',
            type: 'checkpoint',
            modelId: 101055,
            versionId: 128078,
        });
    });

    test('returns null for an invalid AIR', () => {
        expect(parseCivitaiAir('not-an-air')).toBeNull();
    });
});

describe('parseCivitaiLoras', () => {
    test('parses references, strengths, and defaults', () => {
        expect(parseCivitaiLoras('123 = 0.8\nversion:456')).toEqual([
            { reference: '123', strength: 0.8 },
            { reference: 'version:456', strength: 1 },
        ]);
    });

    test('parses AIRs without confusing their colons for separators', () => {
        const air = 'urn:air:sdxl:lora:civitai:10@20';
        expect(parseCivitaiLoras(`${air} = 1.2`)).toEqual([{ reference: air, strength: 1.2 }]);
    });

    test('rejects invalid strengths', () => {
        expect(() => parseCivitaiLoras('123 = strong')).toThrow('invalid strength');
    });
});

describe('flattenCivitaiModels', () => {
    test('returns generation-capable checkpoint versions for the model select', () => {
        const result = flattenCivitaiModels({
            items: [{
                id: 1,
                name: 'Checkpoint',
                type: 'Checkpoint',
                supportsGeneration: true,
                modelVersions: [
                    { id: 2, name: 'v2', baseModel: 'SDXL 1.0', supportsGeneration: true },
                    { id: 3, name: 'offline', baseModel: 'SDXL 1.0', supportsGeneration: false },
                ],
            }, {
                id: 4,
                name: 'LoRA',
                type: 'LORA',
                supportsGeneration: true,
                modelVersions: [{ id: 5, name: 'v1', baseModel: 'SDXL 1.0' }],
            }],
        });

        expect(result).toEqual([{
            value: 'version:2',
            text: 'Checkpoint — v2 (SDXL 1.0)',
            modelId: 1,
            versionId: 2,
            baseModel: 'SDXL 1.0',
        }]);
    });
});

describe('Civitai built-in models', () => {
    test('exposes Krea 2 Raw and Turbo choices', () => {
        expect(CIVITAI_BUILTIN_MODELS.map(model => model.value)).toEqual(['krea2:raw', 'krea2:turbo']);
        expect(getCivitaiBuiltinModel('KREA2:TURBO')).toMatchObject({ ecosystem: 'krea2', variant: 'turbo' });
        expect(getCivitaiBuiltinModel('version:123')).toBeNull();
    });
});

describe('flattenCivitaiLoras', () => {
    test('returns visual LoRA cards with trigger words', () => {
        expect(flattenCivitaiLoras({
            items: [{
                id: 10,
                name: 'Style helper',
                type: 'LORA',
                supportsGeneration: true,
                modelVersions: [{
                    id: 20,
                    name: 'v1',
                    baseModel: 'Illustrious',
                    trainedWords: ['style trigger'],
                    images: [{ url: 'https://example.com/preview.jpg' }],
                }],
            }],
        })).toEqual([{
            value: 'version:20',
            text: 'Style helper — v1',
            modelId: 10,
            versionId: 20,
            baseModel: 'Illustrious',
            preview: 'https://example.com/preview.jpg',
            trainedWords: ['style trigger'],
        }]);
    });
});

describe('buildCivitaiWorkflow', () => {
    test('maps native SillyTavern controls to an SD1 sdcpp workflow', () => {
        const workflow = buildCivitaiWorkflow({
            model: SD1_MODEL,
            ecosystem: 'sd1',
            prompt: 'portrait',
            negativePrompt: 'blurry',
            width: 512,
            height: 768,
            cfgScale: 7,
            steps: 25,
            sampler: 'euler_a',
            scheduler: 'karras',
            clipSkip: 2,
            seed: 42,
            loras: { 'urn:air:sd1:lora:civitai:10@20': 0.8 },
            allowMatureContent: true,
            externalId: 'test-real-1',
        });

        expect(workflow.allowMatureContent).toBe(true);
        expect(workflow.externalId).toBe('test-real-1');
        expect(workflow.steps[0].input).toMatchObject({
            engine: 'sdcpp',
            ecosystem: 'sd1',
            operation: 'createImage',
            model: SD1_MODEL,
            prompt: 'portrait',
            negativePrompt: 'blurry',
            width: 512,
            height: 768,
            cfgScale: 7,
            steps: 25,
            sampleMethod: 'euler_a',
            schedule: 'karras',
            clipSkip: 2,
            seed: 42,
            quantity: 1,
        });
    });

    test('omits SD1-only CLIP skip for SDXL', () => {
        const workflow = buildCivitaiWorkflow({
            model: SDXL_MODEL,
            ecosystem: 'sdxl',
            prompt: 'landscape',
            width: 1024,
            height: 1024,
            cfgScale: 7,
            steps: 20,
            clipSkip: 2,
            externalId: 'test-preview-1',
        });

        expect(workflow.steps[0].input.clipSkip).toBeUndefined();
    });

    test('chains Civitai prompt enhancement into image generation', () => {
        const workflow = buildCivitaiWorkflow({
            model: SDXL_MODEL,
            ecosystem: 'sdxl',
            prompt: 'anime character with sword',
            negativePrompt: 'blurry',
            width: 1024,
            height: 1024,
            cfgScale: 7,
            steps: 25,
            enhancePrompt: true,
            externalId: 'test-enhanced-1',
        });

        expect(workflow.steps[0]).toEqual({
            $type: 'promptEnhancement',
            name: 'enhance',
            input: {
                ecosystem: 'sdxl',
                prompt: 'anime character with sword',
                negativePrompt: 'blurry',
            },
        });
        expect(workflow.steps[1].name).toBe('generate');
        expect(workflow.steps[1].input.prompt).toEqual({ $ref: 'enhance', path: 'output.enhancedPrompt' });
        expect(workflow.steps[1].input.negativePrompt).toEqual({ $ref: 'enhance', path: 'output.enhancedNegativePrompt' });
    });

    test('builds batched img2img with one finishing step per output', () => {
        const workflow = buildCivitaiWorkflow({
            model: SDXL_MODEL,
            ecosystem: 'sdxl',
            prompt: 'restyle this character',
            negativePrompt: 'blurry',
            width: 1024,
            height: 1024,
            cfgScale: 7,
            steps: 25,
            seed: 42,
            quantity: 2,
            sourceImage: 'data:image/png;base64,AAAA',
            strength: 0.65,
            postProcess: 'remove-background',
            externalId: 'test-variant-1',
        });

        expect(workflow.steps[0]).toMatchObject({ $type: 'convertImage', name: 'source-image' });
        expect(workflow.steps[1]).toMatchObject({
            $type: 'imageGen',
            name: 'generate',
            input: {
                operation: 'createVariant',
                image: { $ref: 'source-image', path: 'output.blob.url' },
                strength: 0.65,
                quantity: 2,
            },
        });
        expect(workflow.steps.slice(2).map(step => step.name)).toEqual(['post-0', 'post-1']);
        expect(workflow.metadata.outputStepNames).toEqual(['post-0', 'post-1']);
    });

    test('builds Krea 2 Raw with mapped Comfy controls and community LoRAs', () => {
        const workflow = buildCivitaiWorkflow({
            model: 'krea2:raw',
            ecosystem: 'krea2',
            prompt: 'editorial portrait',
            negativePrompt: 'blurry',
            width: 1024,
            height: 1024,
            cfgScale: 4,
            steps: 20,
            sampler: 'dpm++2m',
            scheduler: 'discrete',
            seed: 42,
            quantity: 2,
            loras: { 'urn:air:krea2:lora:civitai:10@20': 0.8 },
            externalId: 'test-krea-raw',
        });

        expect(workflow.steps[0].input).toMatchObject({
            engine: 'comfy',
            ecosystem: 'krea2',
            model: 'raw',
            operation: 'createImage',
            prompt: 'editorial portrait',
            negativePrompt: 'blurry',
            sampler: 'dpmpp_2m',
            scheduler: 'normal',
            cfgScale: 4,
            steps: 20,
            seed: 42,
            quantity: 2,
            loras: { 'urn:air:krea2:lora:civitai:10@20': 0.8 },
        });
        expect(workflow.steps[0].input.diffusionModel).toBeUndefined();
    });

    test('supports a custom Krea 2 diffusion model and Krea 2 Edit with LoRAs', () => {
        const workflow = buildCivitaiWorkflow({
            model: KREA2_MODEL,
            ecosystem: 'krea2',
            kreaVariant: 'turbo',
            prompt: 'turn this into a comic cover',
            negativePrompt: 'text artifacts',
            width: 1024,
            height: 1536,
            cfgScale: 1,
            steps: 8,
            sampler: 'euler_a',
            scheduler: 'karras',
            quantity: 4,
            sourceImage: 'data:image/png;base64,AAAA',
            strength: 0.25,
            loras: { 'urn:air:krea2:lora:civitai:10@20': 1 },
            externalId: 'test-krea-edit',
        });

        expect(workflow.steps[0]).toMatchObject({ $type: 'convertImage', name: 'source-image' });
        expect(workflow.steps[1].input).toMatchObject({
            engine: 'comfy',
            ecosystem: 'krea2',
            model: 'edit',
            operation: 'editImage',
            diffusionModel: KREA2_MODEL,
            images: [{ $ref: 'source-image', path: 'output.blob.url' }],
            sampler: 'euler_ancestral',
            scheduler: 'karras',
            quantity: 4,
        });
        expect(workflow.steps[1].input.strength).toBeUndefined();

        expect(() => buildCivitaiWorkflow({
            model: 'krea2:raw',
            ecosystem: 'krea2',
            prompt: 'edit',
            width: 1024,
            height: 1024,
            cfgScale: 1,
            steps: 8,
            quantity: 5,
            sourceImage: 'data:image/png;base64,AAAA',
            externalId: 'too-many-edits',
        })).toThrow('1 to 4');
    });

    test('rejects unsupported ecosystems and invalid dimensions', () => {
        expect(() => buildCivitaiWorkflow({
            model: 'urn:air:flux1:checkpoint:civitai:1@2',
            ecosystem: 'flux1',
            prompt: 'test',
            width: 1024,
            height: 1024,
            cfgScale: 1,
            steps: 4,
            externalId: 'test',
        })).toThrow('supports SD1, SDXL, and Krea 2');

        expect(() => buildCivitaiWorkflow({
            model: SD1_MODEL,
            ecosystem: 'sd1',
            prompt: 'test',
            width: 513,
            height: 512,
            cfgScale: 7,
            steps: 20,
            externalId: 'test',
        })).toThrow('divisible by 16');
    });
});

describe('workflow result helpers', () => {
    test('extracts an available signed image URL', () => {
        const image = getCivitaiWorkflowImage({
            steps: [{ output: { images: [{ id: 'blob_1', available: true, url: 'https://example.com/image.png' }] } }],
        });
        expect(image).toEqual({ id: 'blob_1', url: 'https://example.com/image.png' });
    });

    test('extracts every post-processed batch output in order', () => {
        const images = getCivitaiWorkflowImages({
            metadata: { outputStepNames: ['post-0', 'post-1'] },
            steps: [
                { name: 'post-1', output: { image: { id: 'two', url: 'https://example.com/two.png' } } },
                { name: 'post-0', output: { blob: { id: 'one', url: 'https://example.com/one.png' } } },
            ],
        });
        expect(images).toEqual([
            { id: 'one', url: 'https://example.com/one.png' },
            { id: 'two', url: 'https://example.com/two.png' },
        ]);
    });

    test('extracts readable step errors', () => {
        const message = getCivitaiWorkflowError({
            status: 'failed',
            steps: [{ output: { errors: ['Prompt blocked'] } }],
        });
        expect(message).toBe('Prompt blocked');
    });

    test('extracts enhanced prompts and recommendations', () => {
        const enhancement = getCivitaiPromptEnhancement({
            steps: [{
                $type: 'promptEnhancement',
                output: {
                    enhancedPrompt: 'masterpiece, detailed character',
                    enhancedNegativePrompt: 'blurry, low quality',
                    issues: [{ severity: 'warning', description: 'Prompt was vague.' }],
                    recommendations: ['Add lighting details.'],
                },
            }],
        });

        expect(enhancement).toEqual({
            prompt: 'masterpiece, detailed character',
            negativePrompt: 'blurry, low quality',
            issues: [{ severity: 'warning', description: 'Prompt was vague.' }],
            recommendations: ['Add lighting details.'],
        });
    });
});
