# AUR packaging

`PKGBUILD` builds Termax from the git `HEAD` (a VCS `-git` package).

## Build & install locally

```sh
makepkg -si
```

## After changing PKGBUILD

Regenerate the metadata the AUR requires:

```sh
makepkg --printsrcinfo > .SRCINFO
```

## Publishing to the AUR

1. Add your SSH public key at aur.archlinux.org → Account → *My SSH Public Keys*.
2. `git clone ssh://aur@aur.archlinux.org/termax-git.git`
3. Copy `PKGBUILD` and `.SRCINFO` into that clone, commit, and push.

> The `source=` URL must point at a **public** GitHub repo — a private repo
> makes `makepkg` fail with `could not read Username for 'https://github.com'`.

## Stable (non-git) package

When tagged releases exist, add a second `termax` package whose `source=` is the
release tarball (`.../archive/v$pkgver.tar.gz`) and fill `sha256sums` with
`updpkgsums` instead of `SKIP`.
