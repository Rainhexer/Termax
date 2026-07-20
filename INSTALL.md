# Installing Termax

Pre-built installers are published on the [Releases page](https://github.com/Rainhexer/Termax/releases/latest).
The one-liners below grab the **latest** release asset automatically.

> Set the repo once per command. If your fork/repo differs, change `REPO`:
> ```sh
> REPO=Rainhexer/Termax
> ```
> (Each one-liner below sets it inline so it stays copy-paste.)

---

## Any distro — AppImage (no install, just run)

Works on every distro. Requires FUSE and the WebKitGTK runtime (see per-distro
notes below).

```sh
REPO=Rainhexer/Termax; u=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -oE 'https://[^"]+\.AppImage') && mkdir -p ~/.local/bin && curl -fsSL "$u" -o ~/.local/bin/termax && chmod +x ~/.local/bin/termax && echo "installed to ~/.local/bin/termax"
```

Then run `termax` (ensure `~/.local/bin` is on your `$PATH`).

---

## Debian / Ubuntu / Linux Mint / Pop!_OS / elementary (`.deb`)

`apt` pulls the WebKitGTK dependency automatically.

```sh
REPO=Rainhexer/Termax; u=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -oE 'https://[^"]+_amd64\.deb') && curl -fsSL "$u" -o /tmp/termax.deb && sudo apt install -y /tmp/termax.deb
```

## Fedora / RHEL / Rocky / AlmaLinux / Nobara (`.rpm`)

`dnf` installs straight from the asset URL and resolves dependencies.

```sh
REPO=Rainhexer/Termax; u=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -oE 'https://[^"]+\.x86_64\.rpm') && sudo dnf install -y "$u"
```

## openSUSE (Leap / Tumbleweed) (`.rpm`)

```sh
REPO=Rainhexer/Termax; u=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -oE 'https://[^"]+\.x86_64\.rpm') && sudo zypper install --allow-unsigned-rpm -y "$u"
```

## Arch / Manjaro / EndeavourOS

No AUR package yet — use the AppImage (top of this file) after installing its
runtime deps, or [build from source](BUILD.md):

```sh
sudo pacman -S --needed webkit2gtk-4.1 fuse2 gtk3
```

Then run the AppImage one-liner above.

---

## Runtime dependencies (AppImage only)

The `.deb`/`.rpm` packages declare their dependencies, so the package manager
installs them for you. The **AppImage** does not bundle WebKitGTK — install it
manually if the app fails to launch:

| Distro | Command |
|--------|---------|
| Debian/Ubuntu | `sudo apt install -y libwebkit2gtk-4.1-0 libfuse2` |
| Fedora | `sudo dnf install -y webkit2gtk4.1 fuse` |
| openSUSE | `sudo zypper install -y libwebkit2gtk-4_1-0 fuse` |
| Arch | `sudo pacman -S --needed webkit2gtk-4.1 fuse2` |

---

## macOS

Download the `.dmg` from [Releases](https://github.com/Rainhexer/Termax/releases/latest),
open it, and drag **Termax** to Applications. The build is currently unsigned,
so on first launch: right-click the app → **Open** → **Open** (bypasses
Gatekeeper).

## Windows

Download the `.msi` from [Releases](https://github.com/Rainhexer/Termax/releases/latest)
and run it. The installer is currently unsigned, so SmartScreen may warn: click
**More info → Run anyway**.

---

## Uninstall

| Method | Command |
|--------|---------|
| `.deb` | `sudo apt remove termax` |
| `.rpm` (dnf) | `sudo dnf remove termax` |
| `.rpm` (zypper) | `sudo zypper remove termax` |
| AppImage | `rm ~/.local/bin/termax` |
