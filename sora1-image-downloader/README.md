# Sora Image Downloader

A simple script-based workflow for downloading images from the Sora library using Node.js and Playwright.  
This guide walks you through installing dependencies, launching Chrome with remote debugging, and running the downloader script.

## Project Structure

Below is the directory structure used by the downloader:

```
sora-images/
│
├── sora1-image-downloader.js
│	# This script
│
├── manifest-batched.json
│   # List of all images that have already been downloaded
│
├── downloads/
│   ├── picture.png
│   │   # Downloaded image file (filename provided by Sora)
│   └── picture.txt
│       # Full prompt used to generate the image
│
└── error-screenshots/
    ├── error_id.png
    │   # Screenshot captured when an error occurs
    │   # The id matches the id stored in the json file
    └── error_id.txt
        # Error information including:
        # - Image URL
        # - Error details
        # Used for manual downloading or debugging
```

---

## Notice

Some important points to ensure the script works correctly.

- Make sure **all Chrome windows are closed** before launching Chrome with remote debugging.
- The Sora interface **must be set to English**.
- Ensure the page is filtered to **Images** and the URL is:

```
https://sora.chatgpt.com/library?type=images
```

- Always **scroll to the top of the page** before running the script because Sora only loads images near the current viewport.
- Do **not interact with the Chrome window** while the script is running.  
  If you need to browse the web during the download process, **use another browser instead of Chrome**.
- Keep the generated `manifest-batched.json` file if you want downloads to **resume properly**.

---

## Requirements

- **Node.js (LTS)**
- **npm** (included with Node.js)
- **Google Chrome**
- **Windows Command Prompt (cmd.exe)**

---

## Installation

### 1. Install Node.js

Install **Node.js LTS** from the official website:

https://nodejs.org/en/download

After installation, open **Command Prompt (cmd.exe)** and verify:

```bash
node -v
npm -v
```

Both commands should print version numbers.

---

### 2. Download the Project

Download or clone the repository and extract it into the directory where you want Sora images to be saved.

Example:

```bash
cd C:\sora-images
```

---

### 3. Install Playwright

Inside **Command Prompt**, run:

```bash
npm init -y
npm i -D playwright
```

This initializes the project and installs Playwright as a development dependency.

---

## Running the Downloader

### 4. Launch Chrome with Remote Debugging

First, **close all Chrome windows**.

Then start a **new Chrome instance** with a separate profile and remote debugging enabled.

Use whichever path exists on your system.

**Option 1**

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\sora-images\sora-chrome-profiles" --remote-debugging-port=9222
```

**Option 2**

```bash
"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\sora-images\sora-chrome-profiles" --remote-debugging-port=9222
```

---

### 5. Prepare Sora in Chrome

In the Chrome window you just opened:

1. Sign in to **Sora**
2. Switch to **Old Sora**
3. Make sure the interface language is **English**
4. Filter by **Images** so the URL becomes:

```
https://sora.chatgpt.com/library?type=images
```

5. Duplicate the Sora tab **once** (you should have two tabs)
6. Leave both tabs open
7. Scroll to the **top of the page**

---

### 6. Run the Script

Return to **Command Prompt** and run:

```bash
node sora-downloader-batched-v6.js
```

---

### 7. Start the Download Process

When the script prompts you to **press Enter**, do so.

After that:

- Leave the Chrome window **untouched**
- Let the script run
- If you want to browse the web, use **another browser**

---

### 8. Download Output

Downloaded files will be saved inside the script’s **downloads folder**.

The script also generates a file:

```
manifest-batched.json
```

This file stores progress information.  
Keep it if you want future runs to **resume instead of restarting from scratch**.

---

### 9. Resume Later

To continue downloading later:

1. Open **cmd.exe**
2. Navigate back to your project directory:

```bash
cd C:\sora-images
```

3. Repeat the process starting from **Step 4**.

---

## Credit & random rambling

Huge shout-out to @chipperpip on Reddit for writing the original script. I had always wanted to write a script to download all of my Sora images, but I never had the time (and I also couldn’t afford ChatGPT Pro >_<).

This script made it possible for me to salvage my Sora images before Sora 1 shut down.

Although it turns out this was just another one of OpenAI’s many ridiculous lies. You can **simply use a VPN in [countries where Sora 2 is not available](https://help.openai.com/en/articles/12461230-sora-app-and-sora-2-supported-countries) to bypass this meaningless restriction**.

Anyway, OpenAI’s `Export my data` feature has been broken for years, and they don’t seem willing to fix it.

But the good news is that we can now export data from Sora 1 at any time, which conveniently bypasses their hilarious `Export my data` feature that has basically never worked properly.

Things like this keep happening with AI companies, which is why open source is always the best choice. Hopefully we won’t have to write another script in the future just to export our own data manually that something these companies clearly don’t want us to do, even though they’re the ones standing in the way.

Finally, don’t forget to check out [chipperpip’s post](https://www.reddit.com/r/SoraAi/comments/1rrvjrh/lastminute_sora_1_images_bulk_download_script/) and give it a big thumbs-up. Thank you!
