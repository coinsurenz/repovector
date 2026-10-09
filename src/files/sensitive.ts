/** Names that are almost always credentials or key material. Never indexed, whatever the excludes say. */
const SENSITIVE_NAMES = new Set([
  '.env', '.npmrc', '.netrc', '.pgpass', '.git-credentials', '.ssh', '.aws', '.gnupg', '.kube',
  '.docker', '.password-store', '.azure', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SENSITIVE_PATTERNS = [
  /^\.env\./i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /credentials(\.json|\.csv)?$/i,
  /^secrets?\.(ya?ml|json|toml)$/i,
];

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAMES.has(name) || SENSITIVE_PATTERNS.some((re) => re.test(name));
}

/** True when any segment of a repository-relative path (forward slashes) is sensitive, so files inside .aws/ are caught too. */
export function isSensitivePath(relPath: string): boolean {
  return relPath.split('/').some((segment) => segment !== '' && isSensitiveName(segment));
}
