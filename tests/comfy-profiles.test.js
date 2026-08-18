import { describe, expect, test } from '@jest/globals';

import {
    applyComfyProfileSettings,
    captureComfyProfileSettings,
    comfyProfileMatchesSettings,
    createComfyProfile,
    normalizeComfyProfileAssignments,
    normalizeComfyProfiles,
    renameComfyProfile,
    updateComfyProfile,
} from '../public/scripts/extensions/stable-diffusion/comfy-profiles.js';

const currentSettings = {
    source: 'comfy',
    comfy_type: 'standard',
    comfy_url: 'http://192.168.1.2:8188',
    comfy_workflow: 'Character.json',
    model: 'waiIllustrious_v160.safetensors',
    vae: 'Automatic',
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
    steps: 28,
    scale: 6.5,
    width: 832,
    height: 1216,
    seed: -1,
    clip_skip: 2,
    denoising_strength: 0.72,
    prompt_prefix: 'masterpiece, {prompt}',
    negative_prompt: 'low quality',
    comfy_placeholders: [{ find: 'lora_strength', replace: '0.8' }],
};

describe('ComfyUI generation profiles', () => {
    test('captures generation controls without server URLs or credentials', () => {
        const snapshot = captureComfyProfileSettings({
            ...currentSettings,
            apiKey: 'secret',
            comfy_runpod_url: 'https://example.test/private',
        });

        expect(snapshot).toMatchObject({
            comfy_workflow: 'Character.json',
            model: 'waiIllustrious_v160.safetensors',
            sampler: 'dpmpp_2m',
            scheduler: 'karras',
            steps: 28,
            scale: 6.5,
            width: 832,
            height: 1216,
        });
        expect(snapshot).not.toHaveProperty('comfy_url');
        expect(snapshot).not.toHaveProperty('comfy_runpod_url');
        expect(snapshot).not.toHaveProperty('apiKey');
    });

    test('creates, renames, and updates a stable profile', () => {
        const profile = createComfyProfile('Alice portrait', currentSettings, { id: 'alice', now: '2026-08-18T00:00:00.000Z' });
        const renamed = renameComfyProfile(profile, 'Alice cinematic', '2026-08-18T00:01:00.000Z');
        const updated = updateComfyProfile(renamed, { ...currentSettings, steps: 32 }, '2026-08-18T00:02:00.000Z');

        expect(updated).toMatchObject({
            id: 'alice',
            name: 'Alice cinematic',
            createdAt: '2026-08-18T00:00:00.000Z',
            updatedAt: '2026-08-18T00:02:00.000Z',
            settings: { steps: 32 },
        });
    });

    test('applies only allowlisted profile values and deep-clones placeholders', () => {
        const profile = createComfyProfile('Alice', currentSettings, { id: 'alice' });
        const target = { comfy_url: 'http://127.0.0.1:8188', unrelated: true };
        applyComfyProfileSettings(target, profile);

        expect(target.source).toBe('comfy');
        expect(target.model).toBe(currentSettings.model);
        expect(target.comfy_url).toBe('http://127.0.0.1:8188');
        expect(target.unrelated).toBe(true);
        target.comfy_placeholders[0].replace = '1.2';
        expect(profile.settings.comfy_placeholders[0].replace).toBe('0.8');
    });

    test('normalizes corrupt profiles and removes dangling character assignments', () => {
        const valid = createComfyProfile('Alice', currentSettings, { id: 'alice' });
        const profiles = normalizeComfyProfiles([
            valid,
            { ...valid },
            { id: 'civitai', name: 'Wrong provider', source: 'civitai', settings: {} },
            null,
        ]);
        const assignments = normalizeComfyProfileAssignments({
            'Alice.png': 'alice',
            'Bob.png': 'missing',
            '': 'alice',
        }, profiles);

        expect(profiles).toHaveLength(1);
        expect(assignments).toEqual({ 'Alice.png': 'alice' });
    });

    test('detects unsaved changes', () => {
        const profile = createComfyProfile('Alice', currentSettings, { id: 'alice' });
        expect(comfyProfileMatchesSettings(profile, currentSettings)).toBe(true);
        expect(comfyProfileMatchesSettings(profile, { ...currentSettings, steps: 30 })).toBe(false);
    });
});
