// src/r2.js
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class R2 {
  /**
   * @param {Object} cfg
   * @param {string} cfg.accountId         // např. "c515c8ac64b440a5f550d2a3302bc481"
   * @param {string} cfg.accessKeyId
   * @param {string} cfg.secretAccessKey
   * @param {string} cfg.bucket             // např. "melody4u"
   * @param {string} cfg.endpoint           // např. "https://<accountID>.r2.cloudflarestorage.com"
   */
  constructor(cfg) {
    this.bucket = cfg.bucket;
    this.accountId = cfg.accountId;
    this.endpoint = cfg.endpoint?.replace(/\/$/, '');

    this.client = new S3Client({
      region: 'auto',
      endpoint: this.endpoint,     // R2 s3-compatible endpoint
      forcePathStyle: true,        // R2 vyžaduje path-style
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  /**
   * Nahraje objekt do R2
   * @param {string} key
   * @param {Buffer|Uint8Array|ReadableStream|string} body
   * @param {string} [contentType]
   */
  async putObject(key, body, contentType) {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType || undefined,
      ACL: undefined, // R2 ACL nativně nepodporuje – public přístup řeš přes public bucket/doménu
    });
    await this.client.send(cmd);
    return { ok: true, key };
  }

  /**
   * Vygeneruje veřejnou URL. Funguje, když máš public bucket / public doménu
   * Classic: https://<bucket>.<accountId>.r2.cloudflarestorage.com/<key>
   * Custom  : https://cdn.tvoje-domena.cz/<key>   (když endpoint = vlastní doména)
   */
  publicUrl(key) {
    // Pokud používáš custom doménu (např. https://cdn.example.com), vrať ji:
    const u = new URL(this.endpoint);
    // Cloudflare public hostname styl: <bucket>.<accountId>.r2.cloudflarestorage.com
    if (u.hostname.endsWith('.r2.cloudflarestorage.com')) {
      return `https://${this.bucket}.${this.accountId}.r2.cloudflarestorage.com/${encodeURI(key)}`;
    }
    // jinak použij endpoint jako základ (custom doména):
    return `${this.endpoint.replace(/\/$/, '')}/${encodeURI(key)}`;
  }

  /**
   * Podepsaná (dočasná) URL pro GET
   * @param {string} key
   * @param {number} expiresSeconds
   */
  async signedUrl(key, expiresSeconds = 300) {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresSeconds });
  }
}
