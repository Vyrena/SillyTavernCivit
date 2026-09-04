import { describe, expect, test } from '@jest/globals';

import { resolveOpenRouterQuietPromptProcessing } from '../src/openrouter-compatibility.js';

function makeRequest(model, overrides = {}) {
    return {
        chat_completion_source: 'openrouter',
        type: 'quiet',
        model,
        custom_prompt_post_processing: '',
        ...overrides,
    };
}

describe('resolveOpenRouterQuietPromptProcessing', () => {
    for (const model of [
        'deepseek/deepseek-chat',
        'deepseek/deepseek-v4-pro-0813',
        '~deepseek/deepseek-latest',
        'z-ai/glm-5.3',
        '~z-ai/glm-latest',
        'thudm/glm-z1-32b',
    ]) {
        test(`uses semi-strict processing for affected model ${model}`, () => {
            expect(resolveOpenRouterQuietPromptProcessing(makeRequest(model))).toBe('semi');
        });
    }

    test('does not change normal chat requests', () => {
        const request = makeRequest('z-ai/glm-5.3', { type: 'normal' });
        expect(resolveOpenRouterQuietPromptProcessing(request)).toBe('');
    });

    test('does not change other OpenRouter models', () => {
        expect(resolveOpenRouterQuietPromptProcessing(makeRequest('anthropic/claude-sonnet-4.6'))).toBe('');
    });

    test('does not change requests for another source', () => {
        const request = makeRequest('deepseek/deepseek-chat', { chat_completion_source: 'custom' });
        expect(resolveOpenRouterQuietPromptProcessing(request)).toBe('');
    });

    for (const mode of ['semi', 'semi_tools', 'strict', 'strict_tools', 'single']) {
        test(`preserves an existing compatible mode: ${mode}`, () => {
            const request = makeRequest('deepseek/deepseek-chat', { custom_prompt_post_processing: mode });
            expect(resolveOpenRouterQuietPromptProcessing(request)).toBe(mode);
        });
    }

    test('upgrades merge modes while preserving tool support', () => {
        expect(resolveOpenRouterQuietPromptProcessing(makeRequest(
            'z-ai/glm-5.3',
            { custom_prompt_post_processing: 'merge' },
        ))).toBe('semi');
        expect(resolveOpenRouterQuietPromptProcessing(makeRequest(
            'z-ai/glm-5.3',
            { custom_prompt_post_processing: 'merge_tools' },
        ))).toBe('semi_tools');
    });
});
