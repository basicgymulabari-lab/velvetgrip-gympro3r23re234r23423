const SCRIPT_SRC = /(^|;)\s*script-src\s+([^;]*)/i;
const STYLE_SRC = /(^|;)\s*style-src\s+([^;]*)/i;

/** Add a per-response CSP nonce to script and style elements. */
export function addCspNonces(policy: string, nonce: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(nonce)) return null;

  const addNonce = (sourcePolicy: string, directive: RegExp) => {
    const match = directive.exec(sourcePolicy);
    if (!match) return null;

    const sources = match[2]
      .trim()
      .split(/\s+/)
      .filter((source) => source && source !== "'unsafe-inline'" && !/^'nonce-/i.test(source));
    sources.push(`'nonce-${nonce}'`);

    const name = directive === SCRIPT_SRC ? "script-src" : "style-src";
    const replacement = `${match[1]} ${name} ${sources.join(" ")}`;
    return `${sourcePolicy.slice(0, match.index)}${replacement}${sourcePolicy.slice(match.index + match[0].length)}`;
  };

  const scriptsSecured = addNonce(policy, SCRIPT_SRC);
  return scriptsSecured ? addNonce(scriptsSecured, STYLE_SRC) : null;
}
