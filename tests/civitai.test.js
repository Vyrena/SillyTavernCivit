import { describe, expect, test } from '@jest/globals';

import {
    buildCivitaiWorkflow,
    flattenCivitaiModels,
    getCivitaiWorkflowError,
    getCivitaiWorkflowImage,
    parseCivitaiAir,
    parseCivitaiLoras,
    parseCivitaiModelReference,
} from '../src/civitai.js';

const SD1_MODEL = 'urn:air:sd1:checkpoint:civitai:4384@128713';
const SDXL_MODEL = 'urn:air:sdxl:checkpoint:civitai:101055@128078';

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
        })).toThrow('currently supports SD1 and SDXL');

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

    test('extracts readable step errors', () => {
        const message = getCivitaiWorkflowError({
            status: 'failed',
            steps: [{ output: { errors: ['Prompt blocked'] } }],
        });
        expect(message).toBe('Prompt blocked');
    });
});
