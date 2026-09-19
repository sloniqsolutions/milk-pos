# Releasing a new version of Pure Milk POS

A till checks GitHub Releases for `sloniqsolutions/milk-pos` when it starts and
every 4 hours while it stays open. When it finds a newer version a blue banner
appears; **Download & Install** fetches it, and it installs on the next restart
(or straight away with **Restart & Install Now**).

## Cut a release

1. **Bump the version** in `frontend/package.json` (`"version"`). It must be
   *higher* than what is installed — `1.0.4` after `1.0.3`. A till only updates
   to a strictly newer version.
2. **Commit and push** the code.
3. **Have a GitHub token on the machine that builds.** Set once:
   `setx GH_TOKEN "<fine-grained token: this repo, Contents = read & write>"`,
   then open a new terminal. (Only the *builder* needs this. Tills need nothing.)
4. **Build and publish:**
   ```
   cd frontend
   npm run electron:release
   ```
   This builds the installer and uploads three files to a new **published**
   release `v<version>`: `Pure-Milk-POS-Setup-<version>.exe`, its `.blockmap`, and
   `latest.yml`. `latest.yml` is what tills read — the release is useless without it.
5. **Check it:** open <https://github.com/sloniqsolutions/milk-pos/releases> and
   confirm the release is *not* a draft and lists those three files. (`build.publish`
   has `releaseType: "release"`; a draft is invisible to tills.)

`npm run electron:build` builds the installer only, without publishing.

## Installing on another machine

Run `Pure Milk POS Setup <version>.exe` from `frontend/release/`, or from the
release page. The app is already paired to the cloud; on first start it downloads
the branch's staff and history (`backend/sync/bootstrap.js`), so sign in with an
existing cloud staff PIN.

## Where the data lives

`%APPDATA%\pure-milk-pos\data` — database, cloud pairing, device id, activation.
Updates and reinstalls never touch it. In development it is `backend/` in the repo.

**Never store data in the install folder.** The updater deletes that folder on
every update.

## Known limits

- **Installs older than 1.0.3 cannot self-update.** They were built asking for a
  GitHub token that no shop machine has, and they keep their database inside the
  install folder, which the update deletes. Install 1.0.3 (or later) by hand over
  them once. First take a backup (Settings → Backup) if the machine has sales that
  have not synced; anything already synced comes back from the cloud automatically.
- **The releases page is public**, so the installer (and whatever is baked into it)
  is downloadable by anyone. See the note in `frontend/electron/main.js` about the
  branch API key; if the source repo is made private, publish installers to a
  separate public repo and change `build.publish.repo`.
