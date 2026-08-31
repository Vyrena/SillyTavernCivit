import { describe, expect, jest, test } from '@jest/globals';

import {
    APPEARANCE_MEMORY_LIMITS,
    APPEARANCE_MEMORY_VERSION,
    assembleAppearancePrompts,
    createAppearanceSnapshot,
    createEmptyAppearanceMemory,
    mergeAppearanceExtraction,
    normalizeAppearanceMemory,
    pruneAppearanceMemory,
    replayAppearanceSnapshot,
    validateAppearanceExtraction,
} from '../public/scripts/extensions/stable-diffusion/appearance-memory.js';

function makeSubject(overrides = {}) {
    return {
        ref: 'NEW',
        name: 'Mira',
        aliases: ['the bartender'],
        present: true,
        observedCanonical: ['adult woman', 'long black hair', 'amber eyes'],
        observedNegative: ['short hair'],
        persistentChanges: { add: ['green apron'], remove: [] },
        sceneState: {
            pose: ['standing'],
            action: ['holding a book'],
            expression: ['smiling'],
            transient: ['mud on left sleeve'],
        },
        candidateIds: [],
        confidence: 0.95,
        ...overrides,
    };
}

function makeExtraction(subjects = [makeSubject()], scene = {}) {
    return {
        version: APPEARANCE_MEMORY_VERSION,
        scene: {
            setting: ['tavern interior'],
            camera: ['medium shot'],
            interactions: [],
            objects: ['wooden bar'],
            ...scene,
        },
        subjects,
    };
}

function makeEntity(id, overrides = {}) {
    return {
        id,
        displayName: 'Mira',
        aliases: ['the bartender'],
        canonicalTags: ['adult woman', 'long black hair', 'amber eyes'],
        persistentTags: ['green apron'],
        negativeTags: ['short hair'],
        createdMessage: 4,
        lastSeenMessage: 8,
        status: 'active',
        revision: 1,
        ...overrides,
    };
}

describe('chat-local appearance memory', () => {
    test('normalizes corrupt or unsupported data without leaking invalid entities', () => {
        expect(normalizeAppearanceMemory(null)).toEqual(createEmptyAppearanceMemory());
        expect(normalizeAppearanceMemory({ version: 99, entities: {} })).toEqual(createEmptyAppearanceMemory());

        const normalized = normalizeAppearanceMemory({
            version: 1,
            revision: -3,
            enabled: false,
            autoCreate: false,
            entities: {
                'bad id with spaces': makeEntity('bad id with spaces'),
                'e:valid': {
                    ...makeEntity('e:valid'),
                    aliases: ['the bartender', 'THE BARTENDER', null],
                    canonicalTags: ['long black hair', '', 42, 'long black hair'],
                    status: 'unknown',
                },
                'e:mismatch': makeEntity('e:another'),
                'e:not-an-object': 'corrupt',
            },
        });

        expect(normalized).toEqual({
            version: 1,
            revision: 0,
            enabled: false,
            autoCreate: false,
            entities: {
                'e:valid': {
                    ...makeEntity('e:valid'),
                    aliases: ['the bartender'],
                    canonicalTags: ['long black hair'],
                    status: 'active',
                },
            },
        });
    });

    test('strictly rejects unknown fields, excessive output, and invalid references', () => {
        const withUnknownField = makeExtraction();
        withUnknownField.subjects[0].appearance = ['should not be accepted'];
        expect(() => validateAppearanceExtraction(withUnknownField)).toThrow(/exactly/);

        const excessive = makeExtraction([makeSubject({
            observedCanonical: Array.from({ length: APPEARANCE_MEMORY_LIMITS.maxTags + 1 }, (_, index) => `tag ${index}`),
        })]);
        expect(() => validateAppearanceExtraction(excessive)).toThrow(/exceeds/);

        const unknown = makeExtraction([makeSubject({ ref: 'e:missing', name: '', observedCanonical: [] })]);
        expect(() => validateAppearanceExtraction(unknown, { knownEntityIds: ['e:known'] })).toThrow(/known entity/);

        const malformedAmbiguous = makeExtraction([makeSubject({
            ref: 'AMBIGUOUS',
            candidateIds: ['e:one'],
        })]);
        expect(() => validateAppearanceExtraction(malformedAmbiguous, { knownEntityIds: ['e:one'] })).toThrow(/at least two/);

        const overlappingChanges = makeExtraction([makeSubject({
            persistentChanges: { add: ['green apron'], remove: ['GREEN APRON'] },
        })]);
        expect(() => validateAppearanceExtraction(overlappingChanges)).toThrow(/must not overlap/);

        const caseDistinctCandidates = makeExtraction([makeSubject({
            ref: 'AMBIGUOUS',
            candidateIds: ['e:Case', 'e:case'],
        })]);
        expect(validateAppearanceExtraction(caseDistinctCandidates, { knownEntityIds: ['e:Case', 'e:case'] })
            .subjects[0].candidateIds).toEqual(['e:Case', 'e:case']);
    });

    test.each([
        '<lora:malicious-model:1.5>',
        'embedding:malicious_embedding',
        '<hypernet:malicious-hypernet:1>',
        '<lyco:malicious-lyco:0.8>',
        '__malicious/wildcard__',
        '{{prompt}}',
        '${character_name}',
        '{red|blue}',
        '[young:old:0.5]',
        '(red hair:1.8)',
        '(red hair)',
        'BREAK',
    ])('rejects reserved prompt-control syntax in extracted strings: %s', control => {
        const extraction = makeExtraction([makeSubject({ observedCanonical: [control] })]);
        expect(() => validateAppearanceExtraction(extraction)).toThrow(/reserved .* prompt-control syntax/);
    });

    test('accepts benign descriptive punctuation in extracted visual tags', () => {
        const benign = "blue-green eyes, freckles; O'Connor-style bob / gold & silver #2";
        const validated = validateAppearanceExtraction(makeExtraction([makeSubject({
            observedCanonical: [benign],
            persistentChanges: { add: ['navy coat: shoulder-length trim'], remove: [] },
        })]));

        expect(validated.subjects[0].observedCanonical).toEqual([benign]);
        expect(validated.subjects[0].persistentChanges.add).toEqual(['navy coat: shoulder-length trim']);
    });

    test('creates NEW entities only from caller-injected IDs', () => {
        const createEntityId = jest.fn(() => 'e:00000000-0000-4000-8000-000000000001');
        const result = mergeAppearanceExtraction(createEmptyAppearanceMemory(), makeExtraction(), {
            createEntityId,
            messageId: 12,
        });

        expect(createEntityId).toHaveBeenCalledTimes(1);
        expect(result.memory.entities['e:00000000-0000-4000-8000-000000000001']).toMatchObject({
            displayName: 'Mira',
            canonicalTags: ['adult woman', 'long black hair', 'amber eyes'],
            persistentTags: ['green apron'],
            negativeTags: ['short hair'],
            createdMessage: 12,
            lastSeenMessage: 12,
        });
        expect(result.resolutions[0]).toMatchObject({
            kind: 'NEW',
            entityId: 'e:00000000-0000-4000-8000-000000000001',
            present: true,
        });
        expect(result.proposals[0]).toMatchObject({ kind: 'NEW', applied: true });
    });

    test.each(['constructor', 'toString'])('accepts valid prototype-key ID %s without confusing inherited properties for duplicates', entityId => {
        const result = mergeAppearanceExtraction(createEmptyAppearanceMemory(), makeExtraction(), {
            createEntityId: () => entityId,
            messageId: 12,
        });

        expect(Object.hasOwn(result.memory.entities, entityId)).toBe(true);
        expect(result.memory.entities[entityId].id).toBe(entityId);
    });

    test('keeps NEW subjects ephemeral when automatic creation is disabled', () => {
        const memory = { ...createEmptyAppearanceMemory(), autoCreate: false };
        const createEntityId = jest.fn(() => 'e:unused');
        const result = mergeAppearanceExtraction(memory, makeExtraction(), { createEntityId, messageId: 12 });

        expect(createEntityId).not.toHaveBeenCalled();
        expect(result.memory.entities).toEqual({});
        expect(result.resolutions[0]).toMatchObject({ kind: 'NEW', entityId: null });
        expect(result.proposals[0]).toMatchObject({ kind: 'NEW', applied: false });
    });

    test('does not create entities or apply persistent changes below the mutation confidence threshold', () => {
        const memory = {
            ...createEmptyAppearanceMemory(),
            entities: { 'e:mira': makeEntity('e:mira') },
        };
        const createEntityId = jest.fn(() => 'e:low-confidence');
        const lowConfidenceExisting = makeSubject({
            ref: 'e:mira',
            confidence: APPEARANCE_MEMORY_LIMITS.minMutationConfidence - 0.01,
            persistentChanges: { add: ['red coat'], remove: ['green apron'] },
        });
        const lowConfidenceNew = makeSubject({
            confidence: APPEARANCE_MEMORY_LIMITS.minMutationConfidence - 0.01,
        });
        const result = mergeAppearanceExtraction(memory, makeExtraction([lowConfidenceExisting, lowConfidenceNew]), {
            createEntityId,
            messageId: 20,
        });

        expect(createEntityId).not.toHaveBeenCalled();
        expect(result.memory.entities['e:mira'].persistentTags).toEqual(['green apron']);
        expect(result.memory.entities['e:low-confidence']).toBeUndefined();
        expect(result.proposals[0]).toMatchObject({ applied: true, persistentAdded: [], persistentRemoved: [] });
        expect(result.proposals[1]).toMatchObject({ kind: 'NEW', applied: false });
    });

    test('does not create, reactivate, or update memory for subjects that are not present', () => {
        const memory = {
            ...createEmptyAppearanceMemory(),
            revision: 3,
            entities: {
                'e:mira': makeEntity('e:mira', {
                    persistentTags: ['green apron'],
                    lastSeenMessage: 8,
                    status: 'archived',
                    revision: 4,
                }),
            },
        };
        const createEntityId = jest.fn(() => 'e:must-not-be-created');
        const absentExisting = makeSubject({
            ref: 'e:mira',
            present: false,
            observedCanonical: ['short blonde hair'],
            observedNegative: ['long black hair'],
            persistentChanges: { add: ['red coat'], remove: ['green apron'] },
        });
        const absentNew = makeSubject({
            ref: 'NEW',
            name: 'Off-screen stranger',
            present: false,
        });
        const result = mergeAppearanceExtraction(memory, makeExtraction([absentExisting, absentNew]), {
            createEntityId,
            messageId: 20,
        });

        expect(createEntityId).not.toHaveBeenCalled();
        expect(result.memory).toEqual(normalizeAppearanceMemory(memory));
        expect(result.memory.entities['e:mira']).toMatchObject({
            canonicalTags: ['adult woman', 'long black hair', 'amber eyes'],
            persistentTags: ['green apron'],
            negativeTags: ['short hair'],
            lastSeenMessage: 8,
            status: 'archived',
            revision: 4,
        });
        expect(result.resolutions).toMatchObject([
            { kind: 'existing', entityId: 'e:mira', present: false },
            { kind: 'NEW', entityId: null, present: false },
        ]);
        expect(result.proposals).toMatchObject([
            { kind: 'existing', entityId: 'e:mira', applied: false, persistentAdded: [], persistentRemoved: [] },
            { kind: 'NEW', entityId: null, applied: false, persistentAdded: [], persistentRemoved: [] },
        ]);
    });

    test('never overwrites returning canonical tags and changes persistent state only explicitly', () => {
        const memory = {
            ...createEmptyAppearanceMemory(),
            entities: { 'e:mira': makeEntity('e:mira', { persistentTags: ['green apron', 'bandaged hand'] }) },
        };
        const extraction = makeExtraction([makeSubject({
            ref: 'e:mira',
            name: 'A completely different model name',
            aliases: ['invented alias'],
            observedCanonical: ['short blonde hair', 'blue eyes'],
            observedNegative: ['long black hair'],
            persistentChanges: { add: ['red coat'], remove: ['green apron'] },
            sceneState: {
                pose: ['sitting'],
                action: ['reading'],
                expression: ['focused'],
                transient: ['holding a cup'],
            },
        })]);
        const result = mergeAppearanceExtraction(memory, extraction, { messageId: 20 });
        const entity = result.memory.entities['e:mira'];

        expect(entity.displayName).toBe('Mira');
        expect(entity.aliases).toEqual(['the bartender']);
        expect(entity.canonicalTags).toEqual(['adult woman', 'long black hair', 'amber eyes']);
        expect(entity.negativeTags).toEqual(['short hair']);
        expect(entity.persistentTags).toEqual(['bandaged hand', 'red coat']);
        expect(entity.persistentTags).not.toContain('sitting');
        expect(result.resolutions[0].sceneState).toEqual({
            pose: ['sitting'],
            action: ['reading'],
            expression: ['focused'],
            transient: ['holding a cup'],
        });
        expect(result.proposals[0]).toMatchObject({
            kind: 'existing',
            ignoredCanonicalTags: ['short blonde hair', 'blue eyes'],
            ignoredNegativeTags: ['long black hair'],
            persistentAdded: ['red coat'],
            persistentRemoved: ['green apron'],
        });
    });

    test('resolves same-name entities strictly by ID and never merges ambiguous proposals', () => {
        const memory = {
            ...createEmptyAppearanceMemory(),
            entities: {
                'e:mira-one': makeEntity('e:mira-one', { canonicalTags: ['red hair'] }),
                'e:mira-two': makeEntity('e:mira-two', { canonicalTags: ['silver hair'] }),
            },
        };
        const returning = makeSubject({
            ref: 'e:mira-two',
            observedCanonical: ['green hair'],
            observedNegative: [],
            persistentChanges: { add: [], remove: [] },
        });
        const ambiguous = makeSubject({
            ref: 'AMBIGUOUS',
            name: 'Mira',
            observedCanonical: ['wearing a mask'],
            observedNegative: [],
            persistentChanges: { add: [], remove: [] },
            candidateIds: ['e:mira-one', 'e:mira-two'],
        });
        const result = mergeAppearanceExtraction(memory, makeExtraction([returning, ambiguous]), { messageId: 15 });

        expect(result.memory.entities['e:mira-one'].canonicalTags).toEqual(['red hair']);
        expect(result.memory.entities['e:mira-two'].canonicalTags).toEqual(['silver hair']);
        expect(result.resolutions[0]).toMatchObject({ entityId: 'e:mira-two', canonicalTags: ['silver hair'] });
        expect(result.resolutions[1]).toMatchObject({ kind: 'AMBIGUOUS', entityId: null });
        expect(result.proposals[1]).toMatchObject({
            applied: false,
            candidateIds: ['e:mira-one', 'e:mira-two'],
        });
    });

    test('assembles positive and negative prompts deterministically with macro placement', () => {
        const assembled = assembleAppearancePrompts({
            globalPositive: 'masterpiece, {prompt}, cinematic lighting',
            globalNegative: 'low quality',
            commandNegative: 'text',
            scene: {
                setting: ['library'],
                camera: ['medium shot'],
                interactions: ['Mira facing Rowan'],
                objects: ['wooden desk'],
            },
            subjects: [{
                entityId: 'e:mira',
                present: true,
                displayName: 'Mira',
                canonicalTags: ['long black hair', 'amber eyes'],
                persistentTags: ['green apron'],
                negativeTags: ['short hair'],
                sceneState: {
                    pose: ['standing'],
                    action: ['reading'],
                    expression: ['smiling'],
                    transient: [],
                },
            }, {
                entityId: 'e:hidden',
                present: false,
                displayName: 'Hidden',
                canonicalTags: ['must not appear'],
                persistentTags: [],
                negativeTags: ['must not affect negative'],
                sceneState: {},
            }],
        });

        expect(assembled.scenePrompt).toBe('Mira, standing, reading, smiling, library, medium shot, Mira facing Rowan, wooden desk');
        expect(assembled.positivePrompt).toBe(
            'masterpiece, Mira, long black hair, amber eyes, green apron, standing, reading, smiling, library, medium shot, Mira facing Rowan, wooden desk, cinematic lighting',
        );
        expect(assembled.negativePrompt).toBe('text, low quality, short hair');
    });

    test('filters subject negative tags that conflict with any present identity tag', () => {
        const assembled = assembleAppearancePrompts({
            subjects: [{
                present: true,
                displayName: 'Mira',
                canonicalTags: ['short hair'],
                persistentTags: [],
                negativeTags: ['blue eyes'],
                sceneState: {},
            }, {
                present: true,
                displayName: 'Rowan',
                canonicalTags: ['blue eyes'],
                persistentTags: ['red coat'],
                negativeTags: ['SHORT HAIR', 'green coat'],
                sceneState: {},
            }],
        });

        expect(assembled.negativePrompt).toBe('green coat');
    });

    test('creates detached swipe snapshots and safely rejects corrupt replay data', () => {
        const subjects = [{
            entityId: 'e:mira',
            present: true,
            displayName: 'Mira',
            canonicalTags: ['long black hair'],
            persistentTags: ['green apron'],
            negativeTags: ['short hair'],
            sceneState: { pose: ['standing'], action: [], expression: ['smiling'], transient: [] },
        }, {
            entityId: 'e:hidden',
            present: false,
            displayName: 'Hidden',
            canonicalTags: ['hidden'],
            persistentTags: [],
            negativeTags: [],
            sceneState: {},
        }];
        const snapshot = createAppearanceSnapshot({
            memoryRevision: 7,
            scenePrompt: 'Mira, standing, smiling, tavern',
            subjects,
            positivePrompt: 'masterpiece, Mira, long black hair, green apron',
            negativePrompt: 'low quality, short hair',
        });

        expect(snapshot).toMatchObject({
            version: 1,
            memoryRevision: 7,
            positiveSnapshot: 'masterpiece, Mira, long black hair, green apron',
            negativeSnapshot: 'low quality, short hair',
        });
        expect(snapshot.subjects).toHaveLength(1);

        const replay = replayAppearanceSnapshot(snapshot);
        expect(replay).toEqual(snapshot);
        replay.subjects[0].canonicalTags.push('mutation');
        expect(snapshot.subjects[0].canonicalTags).toEqual(['long black hair']);
        expect(replayAppearanceSnapshot({ ...snapshot, version: 2 })).toBeNull();
        expect(replayAppearanceSnapshot({ ...snapshot, subjects: 'corrupt' })).toBeNull();
        expect(replayAppearanceSnapshot({
            ...snapshot,
            subjects: [{ ...snapshot.subjects[0], canonicalTags: 'corrupt' }],
        })).toBeNull();
    });

    test('archives stale entities and prunes archived least-recently-used entries first', () => {
        const memory = {
            ...createEmptyAppearanceMemory(),
            entities: {
                'e:old': makeEntity('e:old', { lastSeenMessage: 10 }),
                'e:recent': makeEntity('e:recent', { lastSeenMessage: 180 }),
                'e:archived': makeEntity('e:archived', { lastSeenMessage: 120, status: 'archived' }),
            },
        };
        const pruned = pruneAppearanceMemory(memory, {
            currentMessage: 200,
            archiveAfterMessages: 100,
            maxEntities: 2,
        });

        expect(Object.keys(pruned.entities)).toEqual(['e:archived', 'e:recent']);
        expect(pruned.entities['e:recent'].status).toBe('active');
        expect(pruned.entities['e:archived'].status).toBe('archived');
        expect(pruned.entities['e:old']).toBeUndefined();
        expect(pruned.revision).toBeGreaterThan(memory.revision);
    });

    test('enforces bounded collection and serialized memory limits deterministically', () => {
        expect(APPEARANCE_MEMORY_LIMITS).toMatchObject({
            maxEntities: 32,
            maxStoredEntities: 64,
            maxSubjects: 12,
            maxAliases: 6,
            maxTags: 16,
            maxTagLength: 120,
            maxPromptLength: 16000,
            maxSerializedMemoryBytes: 256 * 1024,
            maxSerializedSnapshotBytes: 128 * 1024,
        });

        const makeLargeTags = (entityIndex, prefix) => Array.from(
            { length: APPEARANCE_MEMORY_LIMITS.maxTags },
            (_, tagIndex) => `${'界'.repeat(90)}-${prefix}-${entityIndex}-${tagIndex}`,
        );
        const entities = Object.fromEntries(Array.from(
            { length: APPEARANCE_MEMORY_LIMITS.maxStoredEntities },
            (_, index) => {
                const id = `e:${String(index).padStart(3, '0')}`;
                return [id, makeEntity(id, {
                    aliases: Array.from(
                        { length: APPEARANCE_MEMORY_LIMITS.maxAliases },
                        (__, aliasIndex) => `${'名'.repeat(100)}-${index}-${aliasIndex}`,
                    ),
                    canonicalTags: makeLargeTags(index, 'c'),
                    persistentTags: makeLargeTags(index, 'p'),
                    negativeTags: makeLargeTags(index, 'n'),
                    lastSeenMessage: index,
                })];
            },
        ));
        const normalized = normalizeAppearanceMemory({
            ...createEmptyAppearanceMemory(),
            entities,
        }, { maxEntities: APPEARANCE_MEMORY_LIMITS.maxStoredEntities });
        const serializedBytes = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;

        expect(serializedBytes).toBeLessThanOrEqual(APPEARANCE_MEMORY_LIMITS.maxSerializedMemoryBytes);
        expect(Object.keys(normalized.entities).length).toBeLessThan(APPEARANCE_MEMORY_LIMITS.maxStoredEntities);
        expect(normalized.entities['e:063']).toBeDefined();
        expect(normalized).toEqual(normalizeAppearanceMemory({
            ...createEmptyAppearanceMemory(),
            entities,
        }, { maxEntities: APPEARANCE_MEMORY_LIMITS.maxStoredEntities }));
    });

    test('bounds serialized snapshots by dropping trailing diagnostics while preserving replay prompts', () => {
        const makeLargeTags = (subjectIndex, prefix) => Array.from(
            { length: APPEARANCE_MEMORY_LIMITS.maxTags },
            (_, tagIndex) => `${'界'.repeat(90)}-${prefix}-${subjectIndex}-${tagIndex}`,
        );
        const subjects = Array.from({ length: APPEARANCE_MEMORY_LIMITS.maxSubjects }, (_, index) => ({
            entityId: `e:${index}`,
            present: true,
            displayName: `Subject ${index}`,
            canonicalTags: makeLargeTags(index, 'c'),
            persistentTags: makeLargeTags(index, 'p'),
            negativeTags: makeLargeTags(index, 'n'),
            sceneState: {
                pose: makeLargeTags(index, 'pose'),
                action: makeLargeTags(index, 'action'),
                expression: makeLargeTags(index, 'expression'),
                transient: makeLargeTags(index, 'transient'),
            },
        }));
        const snapshot = createAppearanceSnapshot({
            memoryRevision: 5,
            scenePrompt: 'unchanged scene prompt',
            subjects,
            positivePrompt: 'unchanged positive prompt',
            negativePrompt: 'unchanged negative prompt',
        });
        const serializedBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;

        expect(serializedBytes).toBeLessThanOrEqual(APPEARANCE_MEMORY_LIMITS.maxSerializedSnapshotBytes);
        expect(snapshot.subjects.length).toBeLessThan(subjects.length);
        expect(snapshot.subjects[0].entityId).toBe('e:0');
        expect(snapshot.positiveSnapshot).toBe('unchanged positive prompt');
        expect(snapshot.negativeSnapshot).toBe('unchanged negative prompt');
        expect(replayAppearanceSnapshot({ ...snapshot, padding: 'x'.repeat(APPEARANCE_MEMORY_LIMITS.maxSerializedSnapshotBytes) })).toBeNull();
    });
});
