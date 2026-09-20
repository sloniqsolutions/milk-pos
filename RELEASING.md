# Releasing a new version of Pure Milk POS

A till checks GitHub Releases for `sloniqsolutions/milk-pos` when it starts and
every 4 hours while it stays open. When it finds a newer version a blue banner
appears; **Download & Install** fetches it, and it installs on the next restart
(or straight away with **Restart & Install Now**).

## Before you build an installer

Run these two. They take about a minute and catch the failures a shop only finds
after installing:

```
cd backend
node scripts/run-script.js test/fresh-install.js
node scripts/run-script.js test/reports-quick.js
node scripts/run-script.js test/credit-collected.js
node scripts/run-script.js test/credit-filters.js
node scripts/run-script.js test/credit-gaps.js
```

`fresh-install.js` starts the real backend on an empty data folder, paired to a
mock cloud the way the installer pairs a new machine, and checks — with nobody
pressing Restore — that the history loads by itself (even when the cloud is slow),
sign-in waits for it, today's orders are there, the credit figures are right on
every day filter, and each customer's litres, Dahi and balance add up. It exits
non-zero on any failure; do not release until it passes.

Also run `node --test frontend/test/*.test.mjs backend/test/*.test.js`.

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
existing cloud staff PIN. The sign-in screen shows "Setting up your till" while that
runs (up to a couple of minutes for a shop with a long history) and holds sign-in until it
is done. If the internet is down it says so, lets you work offline, and loads the data
by itself when the connection returns — nobody needs to press Restore.

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
