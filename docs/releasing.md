# Releasing

A release is what makes the in-app **Update** button appear. A commit does not —
only a published GitHub Release with a signed archive attached.

## One-time: the signing key

The updater downloads code and runs it, so every release is signed and the gateway
refuses anything that does not verify against the public key compiled into it.
Without that, taking over the GitHub account would be enough to push code to every
install that clicks Update.

```bash
cd routy-core
npm run release:keygen        # writes the pair, embeds the public half
npm run release:keys          # show where things stand
```

The private key is written **outside the repository** (`~/.routy/release-signing.key`
by default). Move it to offline storage — a password manager, a USB key — and delete
the local copy:

```bash
rm ~/.routy/release-signing.key
```

Anyone holding that file can sign a release every install will accept. If it is ever
exposed, generate a new pair and re-release; every existing install will then reject
the old key's signatures, which is the point.

`routy-core/lib/release-pubkey.mjs` **is** committed — it is the public half, and it
is what the gateway verifies against.

## Cutting a release

```bash
# 1. bump the version — the bundle inlines it, so the tag and the code cannot disagree
npm --prefix routy-core version 0.2.0 --no-git-tag-version

# 2. build, pack and sign
cd routy-core && npm run release 0.2.0

# 3. publish (the script prints this command with the real paths)
gh release create v0.2.0 \
  dist/release/routy-0.2.0.tar.gz \
  dist/release/SHA256SUMS \
  dist/release/SHA256SUMS.sig \
  --title "v0.2.0" --notes-file notes.md
```

The release script refuses to run if `package.json` disagrees with the version you
asked for, or if there is no signing key — both are ways to ship a release that lies
about itself.

Write the release notes as if the user will read them, because the dashboard shows
them verbatim in the update card. They are the only place a user learns what changed
before clicking.

## What the archive contains

```
routy.mjs            the launcher — never replaced by an update
current              "0.2.0"
versions/0.2.0/
  routy.mjs          the gateway
  ui/                the dashboard
```

An update unpacks a **new** `versions/<v>/` and rewrites `current`. Nothing running
is ever overwritten, which is what makes this work on Windows (a running `.mjs`
cannot be replaced) and what makes a bad release reversible.

## How an install updates itself

1. The gateway asks GitHub for the latest release — at boot, every 6 hours, or when
   the user clicks **Check again**. Cached in the database; ~4 requests a day.
2. The dashboard offers it. Nothing installs without a click.
3. On click: download the archive, checksums and signature → verify the signature
   against the embedded public key → verify the archive hash against the signed
   checksums → unpack to `versions/<new>/` → repoint `current` → drain → exit 75.
4. The launcher sees the pointer moved and starts the new version.
5. If the new version exits within 15 seconds, the launcher reverts `current` to the
   previous version and starts that instead.

Step 5 is why the launcher exists rather than the app restarting itself: a bad
release leaves users running, not broken.

## Checking an install

```bash
node routy.mjs --versions     # current pointer + what is installed
```

## Opting out

`updateCheck: false` in settings, or the toggle on the Settings page. **No request is
made at all** when it is off — not a cached answer, not a HEAD. This is the only
outbound call the gateway makes that is not to a provider the user configured, which
is why it is a visible, reversible setting rather than something that happens quietly.

## Verifying the pipeline without publishing

```bash
node rigs/update-verify.mjs
```

Lays out a real installed copy, builds a real signed release, serves it over HTTP,
applies it through the API, and checks the launcher brings the new version up — 13
checks, no GitHub and no network beyond loopback. It uses your real signing key, so
it also proves the embedded public key still matches.
