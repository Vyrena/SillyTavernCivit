/**
 * Pure helpers for chat-local Stable Diffusion appearance continuity.
 *
 * This module intentionally has no DOM, storage, or application dependencies. The caller owns
 * entity IDs, chat metadata persistence, and LLM invocation.
 */

export const APPEARANCE_MEMORY_VERSION = 1;

export const APPEARANCE_MEMORY_LIMITS = Object.freeze({
    maxEntities: 32,
    maxStoredEntities: 64,
    maxSubjects: 12,
    maxAliases: 6,
    maxCandidateIds: 8,
    maxTags: 16,
    maxTagLength: 120,
    maxNameLength: 120,
    maxIdLength: 128,
    maxPromptLength: 16000,
    maxSerializedMemoryBytes: 256 * 1024,
    maxSerializedSnapshotBytes: 128 * 1024,
    archiveAfterMessages: 100,
    minMutationConfidence: 0.5,
});

const RESERVED_REFS = new Set(['NEW', 'AMBIGUOUS']);
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const ENTITY_STATUS = new Set(['active', 'archived']);

const EXTRACTION_KEYS = Object.freeze(['version', 'scene', 'subjects']);
const SCENE_KEYS = Object.freeze(['setting', 'camera', 'interactions', 'objects']);
const SUBJECT_KEYS = Object.freeze([
    'ref',
    'name',
    'aliases',
    'present',
    'observedCanonical',
    'observedNegative',
    'persistentChanges',
    'sceneState',
    'candidateIds',
    'confidence',
]);
const CHANGE_KEYS = Object.freeze(['add', 'remove']);
const SCENE_STATE_KEYS = Object.freeze(['pose', 'action', 'expression', 'transient']);
const PROFILE_KEYS = Object.freeze(['displayName', 'canonicalTags', 'negativeTags', 'persistentTags']);
const RESERVED_PROMPT_CONTROL_PATTERNS = Object.freeze([
    { label: 'extra-network', pattern: /<\s*(?:lora|lyco|hypernet|embedding)\s*:/iu },
    { label: 'model-reference', pattern: /\b(?:lora|lyco|hypernet|embedding)\s*:/iu },
    { label: 'wildcard', pattern: /__[^\r\n]+?__/u },
    { label: 'macro', pattern: /\{\{|\}\}|\$\{|\{[A-Za-z_][A-Za-z0-9_.-]*\}|\{[^{}\r\n]*\|[^{}\r\n]*\}|%[A-Za-z_][A-Za-z0-9_.-]*%/u },
    { label: 'weighted-prompt', pattern: /\([^()\r\n]+\)|\[[^[\]\r\n]+\]/u },
    { label: 'prompt-composition', pattern: /^(?:BREAK|AND|AND_PERP)$/u },
]);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNonNegativeInteger(value, fallback = null) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function toPositiveInteger(value, fallback, maximum = APPEARANCE_MEMORY_LIMITS.maxStoredEntities) {
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function normalizeText(value, maximumLength, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') {
        return allowEmpty ? '' : null;
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return allowEmpty ? '' : null;
    }

    return normalized.slice(0, maximumLength);
}

function findReservedPromptControl(value) {
    return RESERVED_PROMPT_CONTROL_PATTERNS.find(({ pattern }) => pattern.test(value))?.label ?? null;
}

function assertNoReservedPromptControl(value, path) {
    const control = findReservedPromptControl(value);
    if (control) {
        throw new TypeError(`${path} contains reserved ${control} prompt-control syntax.`);
    }
}

function normalizePromptText(value, maximumLength, options = {}) {
    const normalized = normalizeText(value, maximumLength, options);
    return normalized && !findReservedPromptControl(normalized) ? normalized : null;
}

function uniqueStrings(values) {
    const seen = new Set();
    const result = [];

    for (const value of values) {
        const key = value.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            result.push(value);
        }
    }

    return result;
}

function normalizeStringList(value, maximumItems = APPEARANCE_MEMORY_LIMITS.maxTags, maximumLength = APPEARANCE_MEMORY_LIMITS.maxTagLength) {
    if (!Array.isArray(value)) {
        return [];
    }

    return uniqueStrings(value
        .slice(0, maximumItems)
        .map(item => normalizePromptText(item, maximumLength))
        .filter(Boolean))
        .slice(0, maximumItems);
}

function isValidEntityId(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= APPEARANCE_MEMORY_LIMITS.maxIdLength
        && ENTITY_ID_PATTERN.test(value)
        && !RESERVED_REFS.has(value);
}

function assertRecord(value, path) {
    if (!isRecord(value)) {
        throw new TypeError(`${path} must be an object.`);
    }
}

function assertExactKeys(value, keys, path) {
    assertRecord(value, path);
    const actualKeys = Object.keys(value).sort();
    const expectedKeys = [...keys].sort();

    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new TypeError(`${path} must contain exactly: ${expectedKeys.join(', ')}.`);
    }
}

function validateStrictString(value, path, maximumLength, { allowEmpty = false, allowPromptControl = false } = {}) {
    if (typeof value !== 'string') {
        throw new TypeError(`${path} must be a string.`);
    }
    if (/[\r\n\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${path} must be a single printable line.`);
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!allowEmpty && !normalized) {
        throw new TypeError(`${path} must not be empty.`);
    }
    if (normalized.length > maximumLength) {
        throw new RangeError(`${path} exceeds ${maximumLength} characters.`);
    }
    if (!allowPromptControl) {
        assertNoReservedPromptControl(normalized, path);
    }

    return normalized;
}

function validateStrictStringList(
    value,
    path,
    maximumItems = APPEARANCE_MEMORY_LIMITS.maxTags,
    maximumLength = APPEARANCE_MEMORY_LIMITS.maxTagLength,
    { caseSensitive = false, allowPromptControl = false } = {},
) {
    if (!Array.isArray(value)) {
        throw new TypeError(`${path} must be an array.`);
    }
    if (value.length > maximumItems) {
        throw new RangeError(`${path} exceeds ${maximumItems} items.`);
    }

    const normalized = value.map((item, index) => validateStrictString(
        item,
        `${path}[${index}]`,
        maximumLength,
        { allowPromptControl },
    ));
    const uniqueCount = caseSensitive ? new Set(normalized).size : uniqueStrings(normalized).length;
    if (uniqueCount !== normalized.length) {
        throw new TypeError(`${path} must not contain duplicate values.`);
    }

    return normalized;
}

function normalizeSceneState(value) {
    const state = isRecord(value) ? value : {};
    return {
        pose: normalizeStringList(state.pose),
        action: normalizeStringList(state.action),
        expression: normalizeStringList(state.expression),
        transient: normalizeStringList(state.transient),
    };
}

function normalizeEntity(key, value) {
    if (!isValidEntityId(key) || !isRecord(value)) {
        return null;
    }
    if (value.id !== undefined && value.id !== key) {
        return null;
    }

    const aliases = normalizeStringList(value.aliases, APPEARANCE_MEMORY_LIMITS.maxAliases, APPEARANCE_MEMORY_LIMITS.maxNameLength);
    const displayName = normalizePromptText(value.displayName, APPEARANCE_MEMORY_LIMITS.maxNameLength)
        || aliases[0]
        || key;

    return {
        id: key,
        displayName,
        aliases,
        canonicalTags: normalizeStringList(value.canonicalTags),
        persistentTags: normalizeStringList(value.persistentTags),
        negativeTags: normalizeStringList(value.negativeTags),
        createdMessage: toNonNegativeInteger(value.createdMessage),
        lastSeenMessage: toNonNegativeInteger(value.lastSeenMessage),
        status: ENTITY_STATUS.has(value.status) ? value.status : 'active',
        revision: toNonNegativeInteger(value.revision, 0),
    };
}

function entityRecency(entity) {
    return entity.lastSeenMessage ?? entity.createdMessage ?? -1;
}

function compareText(left, right) {
    return left < right ? -1 : Number(left > right);
}

function compareEntityRelevance(left, right) {
    const statusDifference = Number(left.status === 'archived') - Number(right.status === 'archived');
    return statusDifference
        || entityRecency(right) - entityRecency(left)
        || (right.createdMessage ?? -1) - (left.createdMessage ?? -1)
        || compareText(left.id, right.id);
}

function retainMostRelevantEntities(entities, maximum) {
    const retained = Object.values(entities)
        .sort(compareEntityRelevance)
        .slice(0, maximum)
        .sort((left, right) => compareText(left.id, right.id));

    return Object.fromEntries(retained.map(entity => [entity.id, entity]));
}

function utf8ByteLength(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                bytes += 4;
                index += 1;
            } else {
                bytes += 3;
            }
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

function serializedByteLength(value) {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? utf8ByteLength(serialized) : Number.POSITIVE_INFINITY;
}

function fitMemoryToSerializedLimit(memory, maximumBytes = APPEARANCE_MEMORY_LIMITS.maxSerializedMemoryBytes) {
    const ranked = Object.values(memory.entities).sort(compareEntityRelevance);
    let retainedCount = ranked.length;
    let candidate;

    do {
        const entities = Object.fromEntries(ranked
            .slice(0, retainedCount)
            .sort((left, right) => compareText(left.id, right.id))
            .map(entity => [entity.id, entity]));
        candidate = { ...memory, entities };
        if (serializedByteLength(candidate) <= maximumBytes) {
            return candidate;
        }
        retainedCount -= 1;
    } while (retainedCount >= 0);

    throw new RangeError(`Appearance memory exceeds ${maximumBytes} serialized bytes.`);
}

function cloneEntity(entity) {
    return {
        ...entity,
        aliases: [...entity.aliases],
        canonicalTags: [...entity.canonicalTags],
        persistentTags: [...entity.persistentTags],
        negativeTags: [...entity.negativeTags],
    };
}

function combineExplicitChanges(current, changes) {
    const removals = new Set(changes.remove.map(tag => tag.toLowerCase()));
    const retained = current.filter(tag => !removals.has(tag.toLowerCase()));
    const combined = uniqueStrings([...retained, ...changes.add]).slice(0, APPEARANCE_MEMORY_LIMITS.maxTags);
    const previous = new Set(current.map(tag => tag.toLowerCase()));
    const next = new Set(combined.map(tag => tag.toLowerCase()));

    return {
        tags: combined,
        added: changes.add.filter(tag => !previous.has(tag.toLowerCase()) && next.has(tag.toLowerCase())),
        removed: current.filter(tag => !next.has(tag.toLowerCase())),
    };
}

function trimPromptPart(value) {
    return typeof value === 'string' ? value.trim().replace(/^,+|,+$/g, '').trim() : '';
}

function joinPromptParts(parts) {
    return parts.map(trimPromptPart).filter(Boolean).join(', ');
}

function applyPromptPrefix(prefix, body) {
    const normalizedPrefix = trimPromptPart(prefix);
    const normalizedBody = trimPromptPart(body);

    if (!normalizedPrefix) {
        return normalizedBody;
    }
    if (normalizedPrefix.includes('{prompt}')) {
        return trimPromptPart(normalizedPrefix.replace('{prompt}', normalizedBody));
    }

    return joinPromptParts([normalizedPrefix, normalizedBody]);
}

/**
 * Creates a fresh chat-local appearance memory envelope.
 * @returns {{version: 1, revision: number, enabled: boolean, autoCreate: boolean, entities: Record<string, object>}}
 */
export function createEmptyAppearanceMemory() {
    return {
        version: APPEARANCE_MEMORY_VERSION,
        revision: 0,
        enabled: true,
        autoCreate: true,
        entities: {},
    };
}

/**
 * Normalizes untrusted chat metadata and discards unsupported versions or corrupt entities.
 * @param {unknown} value Stored chat metadata value.
 * @param {{maxEntities?: number, maxSerializedBytes?: number}} [options] Normalization options.
 * @returns {ReturnType<typeof createEmptyAppearanceMemory>}
 */
export function normalizeAppearanceMemory(value, options = {}) {
    if (!isRecord(value) || value.version !== APPEARANCE_MEMORY_VERSION) {
        return createEmptyAppearanceMemory();
    }

    const maximum = toPositiveInteger(
        options.maxEntities,
        APPEARANCE_MEMORY_LIMITS.maxEntities,
        APPEARANCE_MEMORY_LIMITS.maxStoredEntities,
    );
    const maximumSerializedBytes = toPositiveInteger(
        options.maxSerializedBytes,
        APPEARANCE_MEMORY_LIMITS.maxSerializedMemoryBytes,
        APPEARANCE_MEMORY_LIMITS.maxSerializedMemoryBytes,
    );
    const normalizedEntities = Object.create(null);

    if (isRecord(value.entities)) {
        const entries = Object.entries(value.entities)
            .sort(([left], [right]) => compareText(left, right))
            .slice(0, APPEARANCE_MEMORY_LIMITS.maxStoredEntities);
        for (const [key, entry] of entries) {
            const entity = normalizeEntity(key, entry);
            if (entity) {
                normalizedEntities[entity.id] = entity;
            }
        }
    }

    return fitMemoryToSerializedLimit({
        version: APPEARANCE_MEMORY_VERSION,
        revision: toNonNegativeInteger(value.revision, 0),
        enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
        autoCreate: typeof value.autoCreate === 'boolean' ? value.autoCreate : true,
        entities: retainMostRelevantEntities(normalizedEntities, maximum),
    }, maximumSerializedBytes);
}

/**
 * Strictly validates and sanitizes structured LLM extraction output.
 * @param {unknown} value Structured extraction candidate.
 * @param {{knownEntityIds?: Iterable<string>}} [options] Validation context.
 * @returns {object} A detached validated extraction.
 * @throws {TypeError|RangeError} If the extraction violates the contract.
 */
export function validateAppearanceExtraction(value, options = {}) {
    assertExactKeys(value, EXTRACTION_KEYS, 'extraction');
    if (value.version !== APPEARANCE_MEMORY_VERSION) {
        throw new TypeError(`extraction.version must be ${APPEARANCE_MEMORY_VERSION}.`);
    }

    assertExactKeys(value.scene, SCENE_KEYS, 'extraction.scene');
    const scene = {
        setting: validateStrictStringList(value.scene.setting, 'extraction.scene.setting'),
        camera: validateStrictStringList(value.scene.camera, 'extraction.scene.camera'),
        interactions: validateStrictStringList(value.scene.interactions, 'extraction.scene.interactions'),
        objects: validateStrictStringList(value.scene.objects, 'extraction.scene.objects'),
    };

    if (!Array.isArray(value.subjects)) {
        throw new TypeError('extraction.subjects must be an array.');
    }
    if (value.subjects.length > APPEARANCE_MEMORY_LIMITS.maxSubjects) {
        throw new RangeError(`extraction.subjects exceeds ${APPEARANCE_MEMORY_LIMITS.maxSubjects} items.`);
    }

    const knownEntityIds = options.knownEntityIds === undefined ? null : new Set(options.knownEntityIds);
    const seenExistingRefs = new Set();
    const subjects = value.subjects.map((subject, index) => {
        const path = `extraction.subjects[${index}]`;
        assertExactKeys(subject, SUBJECT_KEYS, path);

        const ref = validateStrictString(
            subject.ref,
            `${path}.ref`,
            APPEARANCE_MEMORY_LIMITS.maxIdLength,
            { allowPromptControl: true },
        );
        if (!RESERVED_REFS.has(ref) && !isValidEntityId(ref)) {
            throw new TypeError(`${path}.ref is not a valid entity ID.`);
        }
        if (!RESERVED_REFS.has(ref) && knownEntityIds && !knownEntityIds.has(ref)) {
            throw new TypeError(`${path}.ref does not identify a known entity.`);
        }
        if (!RESERVED_REFS.has(ref)) {
            if (seenExistingRefs.has(ref)) {
                throw new TypeError(`${path}.ref duplicates another resolved subject.`);
            }
            seenExistingRefs.add(ref);
        }

        const name = validateStrictString(subject.name, `${path}.name`, APPEARANCE_MEMORY_LIMITS.maxNameLength, { allowEmpty: true });
        if (ref === 'NEW' && !name) {
            throw new TypeError(`${path}.name is required for NEW subjects.`);
        }
        if (typeof subject.present !== 'boolean') {
            throw new TypeError(`${path}.present must be a boolean.`);
        }
        if (typeof subject.confidence !== 'number' || !Number.isFinite(subject.confidence) || subject.confidence < 0 || subject.confidence > 1) {
            throw new RangeError(`${path}.confidence must be between 0 and 1.`);
        }

        assertExactKeys(subject.persistentChanges, CHANGE_KEYS, `${path}.persistentChanges`);
        const persistentChanges = {
            add: validateStrictStringList(subject.persistentChanges.add, `${path}.persistentChanges.add`),
            remove: validateStrictStringList(subject.persistentChanges.remove, `${path}.persistentChanges.remove`),
        };
        const additions = new Set(persistentChanges.add.map(tag => tag.toLowerCase()));
        if (persistentChanges.remove.some(tag => additions.has(tag.toLowerCase()))) {
            throw new TypeError(`${path}.persistentChanges.add and remove must not overlap.`);
        }

        assertExactKeys(subject.sceneState, SCENE_STATE_KEYS, `${path}.sceneState`);
        const sceneState = {
            pose: validateStrictStringList(subject.sceneState.pose, `${path}.sceneState.pose`),
            action: validateStrictStringList(subject.sceneState.action, `${path}.sceneState.action`),
            expression: validateStrictStringList(subject.sceneState.expression, `${path}.sceneState.expression`),
            transient: validateStrictStringList(subject.sceneState.transient, `${path}.sceneState.transient`),
        };

        const candidateIds = validateStrictStringList(
            subject.candidateIds,
            `${path}.candidateIds`,
            APPEARANCE_MEMORY_LIMITS.maxCandidateIds,
            APPEARANCE_MEMORY_LIMITS.maxIdLength,
            { caseSensitive: true, allowPromptControl: true },
        );
        if (ref === 'AMBIGUOUS') {
            if (candidateIds.length < 2) {
                throw new TypeError(`${path}.candidateIds must contain at least two IDs for AMBIGUOUS subjects.`);
            }
            for (const candidateId of candidateIds) {
                if (!isValidEntityId(candidateId) || (knownEntityIds && !knownEntityIds.has(candidateId))) {
                    throw new TypeError(`${path}.candidateIds contains an unknown entity ID.`);
                }
            }
        } else if (candidateIds.length > 0) {
            throw new TypeError(`${path}.candidateIds must be empty unless ref is AMBIGUOUS.`);
        }

        return {
            ref,
            name,
            aliases: validateStrictStringList(
                subject.aliases,
                `${path}.aliases`,
                APPEARANCE_MEMORY_LIMITS.maxAliases,
                APPEARANCE_MEMORY_LIMITS.maxNameLength,
            ),
            present: subject.present,
            observedCanonical: validateStrictStringList(subject.observedCanonical, `${path}.observedCanonical`),
            observedNegative: validateStrictStringList(subject.observedNegative, `${path}.observedNegative`),
            persistentChanges,
            sceneState,
            candidateIds,
            confidence: subject.confidence,
        };
    });

    return { version: APPEARANCE_MEMORY_VERSION, scene, subjects };
}

/**
 * Strictly validates a complete user-reviewable appearance profile.
 * @param {unknown} value Profile candidate from text, vision, or an editable preview.
 * @returns {{displayName: string, canonicalTags: string[], negativeTags: string[], persistentTags: string[]}}
 */
export function validateAppearanceProfile(value) {
    assertExactKeys(value, PROFILE_KEYS, 'profile');
    const profile = {
        displayName: validateStrictString(value.displayName, 'profile.displayName', APPEARANCE_MEMORY_LIMITS.maxNameLength),
        canonicalTags: validateStrictStringList(value.canonicalTags, 'profile.canonicalTags'),
        negativeTags: validateStrictStringList(value.negativeTags, 'profile.negativeTags'),
        persistentTags: validateStrictStringList(value.persistentTags, 'profile.persistentTags'),
    };
    if (!profile.canonicalTags.length) {
        throw new TypeError('profile.canonicalTags must include at least one stable visual trait.');
    }
    return profile;
}

/**
 * Merges validated extraction proposals into chat-local memory.
 *
 * Existing canonical/negative tags are authoritative: LLM observations for existing IDs are
 * reported in proposals but never applied. Persistent tags change only through explicit add/remove
 * lists, so omissions never erase state. NEW creation and persistent changes require confidence at
 * or above APPEARANCE_MEMORY_LIMITS.minMutationConfidence.
 *
 * @param {unknown} memory Current chat memory.
 * @param {unknown} extraction Structured extraction output.
 * @param {object} [options] Merge options.
 * @param {(subject: object, index: number) => string} [options.createEntityId] Caller-owned ID factory for NEW entities.
 * @param {number} [options.messageId] Source chat message index.
 * @param {number} [options.maxEntities] Entity cap after merging.
 * @param {number} [options.currentMessage] Message index used for pruning.
 * @param {number} [options.archiveAfterMessages] Archive threshold.
 * @returns {{memory: object, resolutions: object[], proposals: object[]}}
 */
export function mergeAppearanceExtraction(memory, extraction, options = {}) {
    const normalizedMemory = normalizeAppearanceMemory(memory, { maxEntities: APPEARANCE_MEMORY_LIMITS.maxStoredEntities });
    const validated = validateAppearanceExtraction(extraction, { knownEntityIds: Object.keys(normalizedMemory.entities) });
    const entities = Object.fromEntries(Object.entries(normalizedMemory.entities).map(([id, entity]) => [id, cloneEntity(entity)]));
    const messageId = toNonNegativeInteger(options.messageId);
    const resolutions = [];
    const proposals = [];
    let changed = false;

    validated.subjects.forEach((subject, index) => {
        if (!subject.present) {
            const existingEntity = RESERVED_REFS.has(subject.ref) ? null : entities[subject.ref];
            const kind = subject.ref === 'NEW'
                ? 'NEW'
                : subject.ref === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'existing';
            resolutions.push({
                kind,
                entityId: existingEntity?.id ?? null,
                present: false,
                displayName: existingEntity?.displayName ?? subject.name,
                canonicalTags: [...(existingEntity?.canonicalTags ?? subject.observedCanonical)],
                persistentTags: [...(existingEntity?.persistentTags ?? subject.persistentChanges.add)],
                negativeTags: [...(existingEntity?.negativeTags ?? subject.observedNegative)],
                sceneState: normalizeSceneState(subject.sceneState),
            });
            proposals.push({
                kind,
                subjectIndex: index,
                entityId: existingEntity?.id ?? null,
                applied: false,
                candidateIds: [...subject.candidateIds],
                aliasProposals: [...subject.aliases],
                ignoredCanonicalTags: [...subject.observedCanonical],
                ignoredNegativeTags: [...subject.observedNegative],
                persistentAdded: [],
                persistentRemoved: [],
            });
            return;
        }

        if (subject.ref === 'AMBIGUOUS') {
            resolutions.push({
                kind: 'AMBIGUOUS',
                entityId: null,
                present: subject.present,
                displayName: subject.name,
                canonicalTags: [...subject.observedCanonical],
                persistentTags: [...subject.persistentChanges.add],
                negativeTags: [...subject.observedNegative],
                sceneState: normalizeSceneState(subject.sceneState),
            });
            proposals.push({
                kind: 'AMBIGUOUS',
                subjectIndex: index,
                entityId: null,
                applied: false,
                candidateIds: [...subject.candidateIds],
                aliasProposals: [...subject.aliases],
                ignoredCanonicalTags: [...subject.observedCanonical],
                ignoredNegativeTags: [...subject.observedNegative],
                persistentAdded: [],
                persistentRemoved: [],
            });
            return;
        }

        if (subject.ref === 'NEW') {
            if (!normalizedMemory.autoCreate || subject.confidence < APPEARANCE_MEMORY_LIMITS.minMutationConfidence) {
                resolutions.push({
                    kind: 'NEW',
                    entityId: null,
                    present: subject.present,
                    displayName: subject.name,
                    canonicalTags: [...subject.observedCanonical],
                    persistentTags: [...subject.persistentChanges.add],
                    negativeTags: [...subject.observedNegative],
                    sceneState: normalizeSceneState(subject.sceneState),
                });
                proposals.push({
                    kind: 'NEW',
                    subjectIndex: index,
                    entityId: null,
                    applied: false,
                    candidateIds: [],
                    aliasProposals: [...subject.aliases],
                    ignoredCanonicalTags: [],
                    ignoredNegativeTags: [],
                    persistentAdded: [],
                    persistentRemoved: [],
                });
                return;
            }

            if (typeof options.createEntityId !== 'function') {
                throw new TypeError('options.createEntityId is required to merge NEW subjects.');
            }
            const entityId = options.createEntityId(subject, index);
            if (!isValidEntityId(entityId)) {
                throw new TypeError('options.createEntityId returned an invalid entity ID.');
            }
            if (Object.hasOwn(entities, entityId)) {
                throw new TypeError(`options.createEntityId returned duplicate entity ID: ${entityId}.`);
            }

            const entity = {
                id: entityId,
                displayName: subject.name || subject.aliases[0] || entityId,
                aliases: [...subject.aliases],
                canonicalTags: [...subject.observedCanonical],
                persistentTags: [...subject.persistentChanges.add],
                negativeTags: [...subject.observedNegative],
                createdMessage: messageId,
                lastSeenMessage: messageId,
                status: 'active',
                revision: 1,
            };
            Object.defineProperty(entities, entityId, {
                value: entity,
                configurable: true,
                enumerable: true,
                writable: true,
            });
            changed = true;
            resolutions.push({
                kind: 'NEW',
                entityId,
                present: subject.present,
                displayName: entity.displayName,
                canonicalTags: [...entity.canonicalTags],
                persistentTags: [...entity.persistentTags],
                negativeTags: [...entity.negativeTags],
                sceneState: normalizeSceneState(subject.sceneState),
            });
            proposals.push({
                kind: 'NEW',
                subjectIndex: index,
                entityId,
                applied: true,
                candidateIds: [],
                aliasProposals: [...subject.aliases],
                ignoredCanonicalTags: [],
                ignoredNegativeTags: [],
                persistentAdded: [...entity.persistentTags],
                persistentRemoved: [],
            });
            return;
        }

        const entity = entities[subject.ref];
        const persistent = subject.confidence >= APPEARANCE_MEMORY_LIMITS.minMutationConfidence
            ? combineExplicitChanges(entity.persistentTags, subject.persistentChanges)
            : { tags: [...entity.persistentTags], added: [], removed: [] };
        const previousLastSeen = entity.lastSeenMessage;
        const previousStatus = entity.status;
        entity.persistentTags = persistent.tags;
        entity.lastSeenMessage = messageId === null ? entity.lastSeenMessage : Math.max(entity.lastSeenMessage ?? -1, messageId);
        entity.status = 'active';
        const entityChanged = persistent.added.length > 0
            || persistent.removed.length > 0
            || previousLastSeen !== entity.lastSeenMessage
            || previousStatus !== entity.status;
        entity.revision += Number(entityChanged);
        changed = changed || entityChanged;

        resolutions.push({
            kind: 'existing',
            entityId: entity.id,
            present: subject.present,
            displayName: entity.displayName,
            canonicalTags: [...entity.canonicalTags],
            persistentTags: [...entity.persistentTags],
            negativeTags: [...entity.negativeTags],
            sceneState: normalizeSceneState(subject.sceneState),
        });
        proposals.push({
            kind: 'existing',
            subjectIndex: index,
            entityId: entity.id,
            applied: true,
            candidateIds: [],
            aliasProposals: [...subject.aliases],
            ignoredCanonicalTags: [...subject.observedCanonical],
            ignoredNegativeTags: [...subject.observedNegative],
            persistentAdded: persistent.added,
            persistentRemoved: persistent.removed,
        });
    });

    const mergedMemory = {
        ...normalizedMemory,
        revision: normalizedMemory.revision + Number(changed),
        entities,
    };
    const prunedMemory = pruneAppearanceMemory(mergedMemory, {
        maxEntities: options.maxEntities,
        currentMessage: options.currentMessage ?? messageId,
        archiveAfterMessages: options.archiveAfterMessages,
    });

    return { memory: prunedMemory, resolutions, proposals };
}

/**
 * Creates or replaces one complete appearance profile after explicit user review.
 * @param {unknown} memory Current chat-local memory.
 * @param {unknown} profile Complete validated replacement profile.
 * @param {object} [options] Upsert controls.
 * @param {string|null} [options.entityId] Existing entity to replace; null creates a new entity.
 * @param {() => string} [options.createEntityId] Caller-owned ID factory for a new entity.
 * @param {number} [options.messageId] Monotonic appearance sequence for recency.
 * @param {number} [options.maxEntities] Entity cap after the update.
 * @returns {{memory: object, entity: object}}
 */
export function upsertAppearanceProfile(memory, profile, options = {}) {
    const normalizedMemory = normalizeAppearanceMemory(memory, { maxEntities: APPEARANCE_MEMORY_LIMITS.maxStoredEntities });
    const validated = validateAppearanceProfile(profile);
    const entities = Object.fromEntries(Object.entries(normalizedMemory.entities).map(([id, entity]) => [id, cloneEntity(entity)]));
    const messageId = toNonNegativeInteger(options.messageId);
    let entityId = options.entityId ?? null;

    if (entityId !== null) {
        if (!isValidEntityId(entityId) || !Object.hasOwn(entities, entityId)) {
            throw new TypeError('options.entityId does not identify an existing appearance entity.');
        }
        const entity = entities[entityId];
        const previousName = entity.displayName;
        entity.displayName = validated.displayName;
        entity.aliases = uniqueStrings([
            ...entity.aliases,
            previousName,
        ].map(value => normalizePromptText(value, APPEARANCE_MEMORY_LIMITS.maxNameLength)).filter(Boolean))
            .filter(value => value.toLowerCase() !== entity.displayName.toLowerCase())
            .slice(0, APPEARANCE_MEMORY_LIMITS.maxAliases);
        entity.canonicalTags = [...validated.canonicalTags];
        entity.negativeTags = [...validated.negativeTags];
        entity.persistentTags = [...validated.persistentTags];
        entity.lastSeenMessage = messageId === null ? entity.lastSeenMessage : Math.max(entity.lastSeenMessage ?? -1, messageId);
        entity.status = 'active';
        entity.revision += 1;
    } else {
        if (typeof options.createEntityId !== 'function') {
            throw new TypeError('options.createEntityId is required to create an appearance profile.');
        }
        entityId = options.createEntityId();
        if (!isValidEntityId(entityId) || Object.hasOwn(entities, entityId)) {
            throw new TypeError('options.createEntityId returned an invalid or duplicate entity ID.');
        }
        entities[entityId] = {
            id: entityId,
            displayName: validated.displayName,
            aliases: [],
            canonicalTags: [...validated.canonicalTags],
            persistentTags: [...validated.persistentTags],
            negativeTags: [...validated.negativeTags],
            createdMessage: messageId,
            lastSeenMessage: messageId,
            status: 'active',
            revision: 1,
        };
    }

    const updatedMemory = pruneAppearanceMemory({
        ...normalizedMemory,
        revision: normalizedMemory.revision + 1,
        entities,
    }, {
        maxEntities: options.maxEntities,
        currentMessage: messageId,
    });
    const entity = updatedMemory.entities[entityId];
    if (!entity) {
        throw new Error('The saved appearance profile was removed by the memory limit.');
    }
    return { memory: updatedMemory, entity: cloneEntity(entity) };
}

/**
 * Deterministically assembles provider-ready positive and negative prompts.
 * @param {object} options Assembly inputs.
 * @param {string} [options.globalPositive] Global positive prefix; supports `{prompt}`.
 * @param {string} [options.globalNegative] Global negative prefix.
 * @param {string} [options.commandNegative] Per-request negative prefix.
 * @param {object} options.scene Validated scene fields.
 * @param {object[]} options.subjects Resolved subjects in desired prompt order.
 * @returns {{positivePrompt: string, negativePrompt: string, scenePrompt: string}}
 */
export function assembleAppearancePrompts({
    globalPositive = '',
    globalNegative = '',
    commandNegative = '',
    scene = {},
    subjects = [],
} = {}) {
    if (!Array.isArray(subjects) || subjects.length > APPEARANCE_MEMORY_LIMITS.maxSubjects) {
        throw new RangeError(`subjects must contain at most ${APPEARANCE_MEMORY_LIMITS.maxSubjects} items.`);
    }

    const normalizedScene = {
        setting: normalizeStringList(scene?.setting),
        camera: normalizeStringList(scene?.camera),
        interactions: normalizeStringList(scene?.interactions),
        objects: normalizeStringList(scene?.objects),
    };
    const subjectPromptParts = [];
    const subjectSceneParts = [];
    const negativeParts = [];
    const positiveTagKeys = new Set();

    for (const rawSubject of subjects) {
        if (!isRecord(rawSubject) || rawSubject.present === false) {
            continue;
        }
        const displayName = normalizePromptText(rawSubject.displayName, APPEARANCE_MEMORY_LIMITS.maxNameLength, { allowEmpty: true });
        const canonicalTags = normalizeStringList(rawSubject.canonicalTags);
        const persistentTags = normalizeStringList(rawSubject.persistentTags);
        const negativeTags = normalizeStringList(rawSubject.negativeTags);
        const state = normalizeSceneState(rawSubject.sceneState);

        for (const tag of [...canonicalTags, ...persistentTags]) {
            positiveTagKeys.add(tag.toLowerCase());
        }

        subjectPromptParts.push(joinPromptParts([
            displayName,
            ...canonicalTags,
            ...persistentTags,
            ...state.pose,
            ...state.action,
            ...state.expression,
            ...state.transient,
        ]));
        subjectSceneParts.push(joinPromptParts([
            displayName,
            ...state.pose,
            ...state.action,
            ...state.expression,
            ...state.transient,
        ]));
        negativeParts.push(...negativeTags);
    }

    const scenePrompt = joinPromptParts([
        ...subjectSceneParts,
        ...normalizedScene.setting,
        ...normalizedScene.camera,
        ...normalizedScene.interactions,
        ...normalizedScene.objects,
    ]);
    const body = joinPromptParts([
        ...subjectPromptParts,
        ...normalizedScene.setting,
        ...normalizedScene.camera,
        ...normalizedScene.interactions,
        ...normalizedScene.objects,
    ]);
    const positivePrompt = applyPromptPrefix(globalPositive, body);
    const nonConflictingNegativeParts = negativeParts.filter(tag => !positiveTagKeys.has(tag.toLowerCase()));
    const negativePrompt = joinPromptParts([commandNegative, globalNegative, ...nonConflictingNegativeParts]);

    if (positivePrompt.length > APPEARANCE_MEMORY_LIMITS.maxPromptLength || negativePrompt.length > APPEARANCE_MEMORY_LIMITS.maxPromptLength) {
        throw new RangeError(`Assembled prompt exceeds ${APPEARANCE_MEMORY_LIMITS.maxPromptLength} characters.`);
    }

    return { positivePrompt, negativePrompt, scenePrompt };
}

function normalizeSnapshotSubject(value) {
    if (!isRecord(value)) {
        throw new TypeError('Snapshot subjects must be objects.');
    }
    const entityId = value.entityId === null ? null : value.entityId;
    if (entityId !== null && !isValidEntityId(entityId)) {
        throw new TypeError('Snapshot subject entityId is invalid.');
    }
    assertExactKeys(value.sceneState, SCENE_STATE_KEYS, 'snapshot subject sceneState');

    return {
        entityId,
        displayName: validateStrictString(
            value.displayName,
            'snapshot subject displayName',
            APPEARANCE_MEMORY_LIMITS.maxNameLength,
            { allowEmpty: true },
        ),
        canonicalTags: validateStrictStringList(value.canonicalTags, 'snapshot subject canonicalTags'),
        persistentTags: validateStrictStringList(value.persistentTags, 'snapshot subject persistentTags'),
        negativeTags: validateStrictStringList(value.negativeTags, 'snapshot subject negativeTags'),
        sceneState: {
            pose: validateStrictStringList(value.sceneState.pose, 'snapshot subject sceneState.pose'),
            action: validateStrictStringList(value.sceneState.action, 'snapshot subject sceneState.action'),
            expression: validateStrictStringList(value.sceneState.expression, 'snapshot subject sceneState.expression'),
            transient: validateStrictStringList(value.sceneState.transient, 'snapshot subject sceneState.transient'),
        },
    };
}

function validateSnapshotPrompt(value, path) {
    if (typeof value !== 'string') {
        throw new TypeError(`${path} must be a string.`);
    }
    if (value.length > APPEARANCE_MEMORY_LIMITS.maxPromptLength) {
        throw new RangeError(`${path} exceeds ${APPEARANCE_MEMORY_LIMITS.maxPromptLength} characters.`);
    }
    return value;
}

function fitSnapshotToSerializedLimit(snapshot) {
    let retainedCount = snapshot.subjects.length;

    while (retainedCount >= 0) {
        const candidate = {
            ...snapshot,
            subjects: snapshot.subjects.slice(0, retainedCount),
        };
        if (serializedByteLength(candidate) <= APPEARANCE_MEMORY_LIMITS.maxSerializedSnapshotBytes) {
            return candidate;
        }
        retainedCount -= 1;
    }

    throw new RangeError(`Appearance snapshot exceeds ${APPEARANCE_MEMORY_LIMITS.maxSerializedSnapshotBytes} serialized bytes.`);
}

/**
 * Builds immutable-by-convention JSON metadata for deterministic image swipe replay.
 * @param {object} options Snapshot inputs.
 * @returns {object} Serializable attachment metadata.
 */
export function createAppearanceSnapshot({
    memoryRevision = 0,
    scenePrompt = '',
    subjects = [],
    positivePrompt = '',
    negativePrompt = '',
} = {}) {
    if (!Number.isSafeInteger(memoryRevision) || memoryRevision < 0) {
        throw new TypeError('memoryRevision must be a non-negative integer.');
    }
    if (!Array.isArray(subjects) || subjects.length > APPEARANCE_MEMORY_LIMITS.maxSubjects) {
        throw new RangeError(`subjects must contain at most ${APPEARANCE_MEMORY_LIMITS.maxSubjects} items.`);
    }

    const presentSubjects = subjects.filter(subject => subject?.present !== false).map(normalizeSnapshotSubject);
    return fitSnapshotToSerializedLimit({
        version: APPEARANCE_MEMORY_VERSION,
        memoryRevision,
        scenePrompt: validateSnapshotPrompt(scenePrompt, 'scenePrompt'),
        subjects: presentSubjects,
        positiveSnapshot: validateSnapshotPrompt(positivePrompt, 'positivePrompt'),
        negativeSnapshot: validateSnapshotPrompt(negativePrompt, 'negativePrompt'),
    });
}

/**
 * Validates and clones attachment metadata for swipe replay.
 * @param {unknown} value Stored snapshot candidate.
 * @returns {object|null} A detached normalized snapshot, or null when unsupported/corrupt.
 */
export function replayAppearanceSnapshot(value) {
    if (!isRecord(value) || value.version !== APPEARANCE_MEMORY_VERSION) {
        return null;
    }

    try {
        if (serializedByteLength(value) > APPEARANCE_MEMORY_LIMITS.maxSerializedSnapshotBytes) {
            return null;
        }
        return createAppearanceSnapshot({
            memoryRevision: value.memoryRevision,
            scenePrompt: value.scenePrompt,
            subjects: value.subjects,
            positivePrompt: value.positiveSnapshot,
            negativePrompt: value.negativeSnapshot,
        });
    } catch {
        return null;
    }
}

/**
 * Archives stale entities and applies a deterministic least-recently-used entity cap.
 * @param {unknown} memory Chat-local memory.
 * @param {object} [options] Pruning controls.
 * @returns {object} A detached normalized memory envelope.
 */
export function pruneAppearanceMemory(memory, options = {}) {
    const maxEntities = toPositiveInteger(options.maxEntities, APPEARANCE_MEMORY_LIMITS.maxEntities);
    const archiveAfterMessages = toPositiveInteger(
        options.archiveAfterMessages,
        APPEARANCE_MEMORY_LIMITS.archiveAfterMessages,
        Number.MAX_SAFE_INTEGER,
    );
    const currentMessage = toNonNegativeInteger(options.currentMessage);
    const normalized = normalizeAppearanceMemory(memory, { maxEntities: APPEARANCE_MEMORY_LIMITS.maxStoredEntities });
    const entities = Object.fromEntries(Object.entries(normalized.entities).map(([id, entity]) => [id, cloneEntity(entity)]));
    let changed = false;

    if (currentMessage !== null) {
        for (const entity of Object.values(entities)) {
            const lastSeen = entityRecency(entity);
            if (lastSeen >= 0 && currentMessage - lastSeen >= archiveAfterMessages && entity.status !== 'archived') {
                entity.status = 'archived';
                entity.revision += 1;
                changed = true;
            }
        }
    }

    const retained = retainMostRelevantEntities(entities, maxEntities);
    if (Object.keys(retained).length !== Object.keys(entities).length) {
        changed = true;
    }

    let result = {
        ...normalized,
        revision: normalized.revision + Number(changed),
        entities: retained,
    };
    let fitted = fitMemoryToSerializedLimit(result);
    if (Object.keys(fitted.entities).length !== Object.keys(result.entities).length && !changed) {
        result = { ...result, revision: result.revision + 1 };
        fitted = fitMemoryToSerializedLimit(result);
    }
    return fitted;
}
