import { S3Client } from '../src/storage/s3';

// AWS 文档中的签名示例（Signature Version 4，S3）：同一组示例密钥与时间，签名结果是公开的
const aws = new S3Client({
  endpoint: 'https://s3.amazonaws.com',
  publicEndpoint: 'https://s3.amazonaws.com',
  region: 'us-east-1',
  bucket: 'examplebucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: false,
});
const now = new Date('2013-05-24T00:00:00Z');
const signatureOf = (authorization: string) => /Signature=([0-9a-f]{64})$/.exec(authorization)?.[1];

describe('S3 签名（AWS Signature V4 示例）', () => {
  it('预签名 GET 地址', () => {
    const url = new URL(aws.presign('GET', 'test.txt', { expiresSec: 86400, now }));
    expect(url.host).toBe('examplebucket.s3.amazonaws.com');
    expect(url.pathname).toBe('/test.txt');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('请求头签名：带 Range 的 GET', () => {
    const h = aws.signHeaders('GET', aws.objectUrl('test.txt'), { Range: 'bytes=0-9' }, undefined, now);
    expect(h['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(h.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
    expect(signatureOf(h.authorization)).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('请求头签名：PUT，对象名中的特殊字符按 RFC 3986 编码', () => {
    const url = aws.objectUrl('test$file.text');
    expect(url.pathname).toBe('/test%24file.text');
    const h = aws.signHeaders('PUT', url, { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, Buffer.from('Welcome to Amazon S3.'), now);
    expect(h['x-amz-content-sha256']).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    expect(signatureOf(h.authorization)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('路径风格地址（MinIO）与浏览器访问地址', () => {
    const minio = new S3Client({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'creature',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
    });
    expect(minio.objectUrl('public/u1/a.png').toString()).toBe('http://minio:9000/creature/public/u1/a.png');
    const signed = new URL(minio.presign('PUT', 'private/u1/x.png', { expiresSec: 900, headers: { 'Content-Type': 'image/png', 'Content-Length': '42' } }));
    expect(signed.origin).toBe('http://localhost:9000');
    expect(signed.pathname).toBe('/creature/private/u1/x.png');
    expect(signed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
  });
});
