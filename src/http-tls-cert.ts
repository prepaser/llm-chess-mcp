import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";

export type HttpTlsServerOptions = {
  key: string;
  cert: string;
  minVersion: "TLSv1.2";
};

export type TlsCertificate = {
  cert: string;
  key: string;
  notBefore: number;
  expiresAt: number;
  renewAt: number;
  context: SecureContext;
  serverOptions: HttpTlsServerOptions;
};

export function validateCertificate(
  cert: string,
  key: string,
  now: number,
  domain?: string,
): TlsCertificate {
  if (!cert || cert.includes("\0")) throw new Error("invalid TLS certificate");
  if (!key || key.includes("\0")) throw new Error("invalid TLS private key");
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch (error) {
    throw new Error("invalid TLS certificate", { cause: error });
  }
  const notBefore = Date.parse(x509.validFrom);
  const expiresAt = Date.parse(x509.validTo);
  if (domain && !x509.checkHost(domain, { wildcards: false })) {
    throw new Error("TLS certificate does not match the ACME domain");
  }
  if (
    !Number.isFinite(notBefore) ||
    !Number.isFinite(expiresAt) ||
    notBefore > now ||
    expiresAt <= now
  ) {
    throw new Error("TLS certificate is not currently valid");
  }
  let certPublic: Buffer;
  let keyPublic: Buffer;
  try {
    certPublic = x509.publicKey.export({ format: "der", type: "spki" });
    keyPublic = createPublicKey(createPrivateKey(key)).export({
      format: "der",
      type: "spki",
    });
  } catch (error) {
    throw new Error("invalid TLS private key", { cause: error });
  }
  if (certPublic.length !== keyPublic.length || !timingSafeEqual(certPublic, keyPublic)) {
    throw new Error("TLS certificate and private key do not match");
  }
  let context: SecureContext;
  try {
    context = createSecureContext({ cert, key });
  } catch (error) {
    throw new Error("invalid TLS certificate or private key", { cause: error });
  }
  return {
    cert,
    key,
    notBefore,
    expiresAt,
    renewAt: notBefore + (expiresAt - notBefore) * (2 / 3),
    context,
    serverOptions: { cert, key, minVersion: "TLSv1.2" },
  };
}
