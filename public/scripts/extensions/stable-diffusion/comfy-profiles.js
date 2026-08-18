export const COMFY_PROFILE_SOURCE = 'comfy';

export const COMFY_PROFILE_FIELDS = Object.freeze([
    'comfy_type',
    'comfy_workflow',
    'model',
    'vae',
    'sampler',
    'scheduler',
    'steps',
    'scale',
    'width',
    'height',
    'seed',
    'clip_skip',
    'denoising_strength',
    'prompt_prefix',
    'negative_prompt',
    'comfy_placeholders',
]);

function cloneProfileValue(value) {
    if (Array.isArray(value)) {
        return value.map(cloneProfileValue);
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneProfileValue(entry)]));
    }

    return value;
}

function createProfileId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }

    return `comfy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function captureComfyProfileSettings(settings) {
    const snapshot = {};

    for (const field of COMFY_PROFILE_FIELDS) {
        if (settings?.[field] !== undefined) {
            snapshot[field] = cloneProfileValue(settings[field]);
        }
    }

    return snapshot;
}

export function createComfyProfile(name, settings, options = {}) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
        throw new Error('Profile name is required.');
    }

    const now = String(options.now || new Date().toISOString());
    return {
        id: String(options.id || createProfileId()),
        name: normalizedName,
        source: COMFY_PROFILE_SOURCE,
        settings: captureComfyProfileSettings(settings),
        createdAt: now,
        updatedAt: now,
    };
}

export function updateComfyProfile(profile, settings, now = new Date().toISOString()) {
    return {
        ...profile,
        settings: captureComfyProfileSettings(settings),
        updatedAt: String(now),
    };
}

export function renameComfyProfile(profile, name, now = new Date().toISOString()) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
        throw new Error('Profile name is required.');
    }

    return {
        ...profile,
        name: normalizedName,
        updatedAt: String(now),
    };
}

export function applyComfyProfileSettings(target, profile) {
    if (!target || typeof target !== 'object') {
        throw new Error('A settings object is required.');
    }
    if (!profile || profile.source !== COMFY_PROFILE_SOURCE || !profile.settings || typeof profile.settings !== 'object') {
        throw new Error('Invalid ComfyUI profile.');
    }

    target.source = COMFY_PROFILE_SOURCE;
    for (const field of COMFY_PROFILE_FIELDS) {
        if (profile.settings[field] !== undefined) {
            target[field] = cloneProfileValue(profile.settings[field]);
        }
    }

    return target;
}

export function normalizeComfyProfiles(profiles) {
    if (!Array.isArray(profiles)) {
        return [];
    }

    const seenIds = new Set();
    return profiles.flatMap((profile) => {
        const id = String(profile?.id || '').trim();
        const name = String(profile?.name || '').trim();
        if (!id || !name || seenIds.has(id) || profile?.source !== COMFY_PROFILE_SOURCE || !profile.settings || typeof profile.settings !== 'object') {
            return [];
        }

        seenIds.add(id);
        return [{
            id,
            name,
            source: COMFY_PROFILE_SOURCE,
            settings: captureComfyProfileSettings(profile.settings),
            createdAt: String(profile.createdAt || ''),
            updatedAt: String(profile.updatedAt || ''),
        }];
    });
}

export function normalizeComfyProfileAssignments(assignments, profiles) {
    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
        return {};
    }

    const validProfileIds = new Set(normalizeComfyProfiles(profiles).map(profile => profile.id));
    return Object.fromEntries(Object.entries(assignments)
        .map(([characterKey, profileId]) => [String(characterKey || '').trim(), String(profileId || '').trim()])
        .filter(([characterKey, profileId]) => characterKey && validProfileIds.has(profileId)));
}

export function comfyProfileMatchesSettings(profile, settings) {
    if (!profile || profile.source !== COMFY_PROFILE_SOURCE) {
        return false;
    }

    return JSON.stringify(profile.settings) === JSON.stringify(captureComfyProfileSettings(settings));
}
