// Minimal GitHub contents API client for one repository.

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class ConflictError extends Error {}

export class Repo {
  constructor(owner, repo, token) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.branch = null;
  }

  async api(path, opts = {}) {
    const res = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}${path}`, {
      ...opts,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.headers || {}),
      },
    });
    return res;
  }

  async init() {
    const res = await this.api("");
    if (res.status === 401) throw new Error("GitHub rejected the token (401). Check the token in Settings.");
    if (res.status === 404) throw new Error(`Repository ${this.owner}/${this.repo} not found, or the token cannot see it.`);
    if (!res.ok) throw new Error(`GitHub error ${res.status}`);
    const info = await res.json();
    this.branch = info.default_branch;
  }

  // Returns {text, sha} or null if the file does not exist.
  async read(path) {
    const res = await this.api(`/contents/${path}?ref=${this.branch}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Reading ${path}: GitHub error ${res.status}`);
    const j = await res.json();
    return { text: fromBase64(j.content), sha: j.sha };
  }

  // Writes a file. sha must be the version being replaced, or null for a new file.
  // Returns the new sha. Throws ConflictError if the file changed in the meantime.
  async write(path, text, sha, message) {
    const body = { message, content: toBase64(text), branch: this.branch };
    if (sha) body.sha = sha;
    const res = await this.api(`/contents/${path}`, { method: "PUT", body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) throw new ConflictError(`${path} was changed elsewhere`);
    if (!res.ok) throw new Error(`Saving ${path}: GitHub error ${res.status}`);
    const j = await res.json();
    return j.content.sha;
  }

  // Lists the dates of all snapshot files, sorted.
  async snapshotDates() {
    const res = await this.api(`/git/trees/${this.branch}?recursive=1`);
    if (!res.ok) throw new Error(`Listing history: GitHub error ${res.status}`);
    const j = await res.json();
    return j.tree
      .map((t) => t.path.match(/^history\/\d{4}\/(\d{4}-\d{2}-\d{2})\.md$/))
      .filter(Boolean)
      .map((m) => m[1])
      .sort();
  }
}
