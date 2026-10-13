# Tof

Stats and a reader for TextNow conversation exports. Runs entirely in the browser: exports are never uploaded.

- Open the site, tap **Choose files**, and pick one or more TextNow `.html` exports.
- On Android, open the site in Chrome, use **Add to Home screen** (or the Install Tof button), and Tof shows up in TextNow's **Share** menu. Sharing an export opens it straight in Tof.

Hosted with GitHub Pages from the repository root. No build step.

## Android app

`android/` wraps the same page in a small Android app that appears in the Share menu. Every push to `main` builds it with GitHub Actions and publishes `tof.apk` on the [Android release](https://github.com/lamposian/tof/releases/tag/android). Download it on the phone and open it to install.
