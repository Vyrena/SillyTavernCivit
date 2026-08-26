const SYSTEM_FIRST_OPENROUTER_MODEL = /^~?(?:deepseek\/|z-ai\/glm(?:[-/:]|$)|thudm\/glm(?:[-/:]|$))/i;

/**
 * Selects prompt post-processing for OpenRouter quiet generations.
 *
 * DeepSeek and GLM chat templates can reject system messages that appear after
 * conversation history. Quiet generations append their instruction as a
 * system message, so use semi-strict processing unless the user already chose
 * an equally strict mode.
 *
 * @param {object} body Chat completion request body
 * @returns {string|undefined} Prompt post-processing type
 */
export function resolveOpenRouterQuietPromptProcessing(body) {
    const configuredType = body?.custom_prompt_post_processing;
    const isAffectedRequest = body?.chat_completion_source === 'openrouter'
        && body?.type === 'quiet'
        && SYSTEM_FIRST_OPENROUTER_MODEL.test(String(body?.model || ''));

    if (!isAffectedRequest) {
        return configuredType;
    }

    switch (configuredType) {
        case undefined:
        case '':
        case 'claude':
        case 'merge':
            return 'semi';
        case 'merge_tools':
            return 'semi_tools';
        default:
            return configuredType;
    }
}
