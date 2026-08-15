import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const fetchMock = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    readSecret: jest.fn(),
    SECRET_KEYS: { CIVITAI: 'civitai' },
}));

const { downloadCivitaiImage } = await import('../src/endpoints/civitai.js');

function makeResponse(status, { body = '', headers = {} } = {}) {
    const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: key => normalizedHeaders[String(key).toLowerCase()] ?? null },
        arrayBuffer: jest.fn(async () => buffer),
        text: jest.fn(async () => buffer.toString()),
    };
}

describe('downloadCivitaiImage', () => {
    beforeEach(() => fetchMock.mockReset());

    test('refreshes a forbidden signed URL through authenticated GetBlob without leaking the token to the CDN', async () => {
        fetchMock
            .mockResolvedValueOnce(makeResponse(403))
            .mockResolvedValueOnce(makeResponse(302, { headers: { location: 'https://cdn.example/fresh.png' } }))
            .mockResolvedValueOnce(makeResponse(200, {
                body: Buffer.from('image-bytes'),
                headers: { 'content-type': 'image/png' },
            }));

        const result = await downloadCivitaiImage({
            id: 'blob_output.png',
            url: 'https://cdn.example/expired.png',
        }, 'secret-token', 'wf_123');

        expect(result).toEqual({
            format: 'png',
            image: Buffer.from('image-bytes').toString('base64'),
            bytes: 11,
        });
        expect(String(fetchMock.mock.calls[0][0])).toBe('https://cdn.example/expired.png');
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
        expect(String(fetchMock.mock.calls[1][0])).toBe('https://orchestration.civitai.com/v2/consumer/blobs/blob_output.png?workflowId=wf_123');
        expect(fetchMock.mock.calls[1][1]).toMatchObject({
            redirect: 'manual',
            headers: { Authorization: 'Bearer secret-token', Accept: 'image/*' },
        });
        expect(String(fetchMock.mock.calls[2][0])).toBe('https://cdn.example/fresh.png');
        expect(fetchMock.mock.calls[2][1].headers.Authorization).toBeUndefined();
    });

    test('returns a single non-retryable 403 when authenticated blob refresh is denied', async () => {
        fetchMock
            .mockResolvedValueOnce(makeResponse(403))
            .mockResolvedValueOnce(makeResponse(403, {
                body: JSON.stringify({ detail: 'Mature output permission required.' }),
                headers: { 'content-type': 'application/json' },
            }));

        await expect(downloadCivitaiImage({
            id: 'blob_restricted.png',
            url: 'https://cdn.example/restricted.png',
        }, 'secret-token', 'wf_restricted')).rejects.toMatchObject({
            status: 403,
            message: expect.stringContaining('Mature output permission required.'),
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('recovers from a malformed output URL when Civitai returned a blob ID', async () => {
        fetchMock
            .mockResolvedValueOnce(makeResponse(308, { headers: { location: 'https://cdn.example/recovered.webp' } }))
            .mockResolvedValueOnce(makeResponse(200, {
                body: Buffer.from('webp-bytes'),
                headers: { 'content-type': 'image/webp' },
            }));

        const result = await downloadCivitaiImage({ id: 'blob_recovered.webp', url: 'not a URL' }, 'token', 'wf_recovered');

        expect(result.format).toBe('webp');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
