# Barkasse Plymouth Splash Theme

This theme shows your branded background image as early as possible during boot (initramfs), before Wayland/Chromium start.

## Files
- `barkasse/barkasse.plymouth`: Theme manifest
- `barkasse/barkasse.script`: Script that renders the background and a status message
- expected image: `background.png` — place it next to the theme files on the device

## Install on the device
1. Install Plymouth (if not already):
   - Debian/Raspberry Pi OS/Ubuntu:
     - `sudo apt-get update`
     - `sudo apt-get install plymouth plymouth-themes`

2. Copy theme files to system path:
   ```bash
   sudo mkdir -p /usr/share/plymouth/themes/barkasse
   sudo cp plymouth/barkasse/barkasse.plymouth /usr/share/plymouth/themes/barkasse/
   sudo cp plymouth/barkasse/barkasse.script /usr/share/plymouth/themes/barkasse/
   # Copy your background image from the repo
   sudo cp ui/assets/background.png /usr/share/plymouth/themes/barkasse/background.png
   ```
   - If your asset has a different name or format (jpg/svg), convert/rename to `background.png`.
   - Prefer a resolution matching your screen; Plymouth will scale to cover.

3. Set the theme:
   ```bash
   sudo plymouth-set-default-theme barkasse
   ```
   - On some distros: `sudo update-alternatives --config default.plymouth`

4. Rebuild initramfs so the theme is used during early boot:
   - Debian/Ubuntu/Raspberry Pi OS:
     ```bash
     sudo update-initramfs -u
     ```
   - If using a custom kernel or distribution, use the equivalent initramfs update command.

5. Reboot and verify:
   ```bash
   sudo reboot
   ```
   You should see the Barkasse background very early in boot.

## Tips
- If boot messages overlap, you can reduce console verbosity or use `splash quiet` in kernel cmdline (`/boot/cmdline.txt` on Raspberry Pi OS). Be cautious when changing kernel cmdline; ensure serial/debug access if needed.
- If Plymouth doesn’t appear, verify your initramfs includes Plymouth and that the bootloader enables it. On some minimal systems, additional steps may be needed.
- To tweak text or show a spinner, extend `barkasse.script` (e.g., draw an animated image or progress dots).
