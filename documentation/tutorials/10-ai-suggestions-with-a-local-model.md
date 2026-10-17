# Tutorial 10 — AI suggestions with a model on your own server

WordJS can suggest a post's **excerpt**, its **meta description** and an image's **alt text**. The
editor always shows these as a suggestion that you accept or discard; nothing is saved without you.
The model can be Claude, OpenAI, or any server that speaks the OpenAI API. In this tutorial you run a
small open model with **Ollama** on the same machine as WordJS, so nothing leaves your server and no
API key is needed.

**Time:** about 20 minutes, mostly the model download.
**You need:** a WordJS site and an administrator account, and on the server about 2 GB of free RAM
and 2 GB of disk. A GPU is not required for text.

## 1. Install Ollama and a model

On the WordJS server:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

```bash
ollama pull qwen2.5:1.5b
```

The installer sets Ollama up as a service listening on `127.0.0.1:11434`, which is reachable only from
the server itself. `qwen2.5:1.5b` is a 1 GB model, small enough for a CPU and good enough for one or
two sentences. Check that it answers:

```bash
curl -s http://127.0.0.1:11434/v1/chat/completions -H "content-type: application/json" -d '{"model":"qwen2.5:1.5b","messages":[{"role":"user","content":"Say hello in five words."}]}'
```

## 2. Connect WordJS to it

Open **Admin → Settings → AI** and set:

| Field | Value |
|---|---|
| **Provider** | **OpenAI-compatible (OpenAI, Ollama, LM Studio…)** |
| **Base URL** | `http://127.0.0.1:11434/v1` |
| **Model** | `qwen2.5:1.5b` |
| **API key** | *(empty; Ollama needs none)* |

Click **Save**, then **Test connection**. It answers *Connected to qwen2.5:1.5b (… ms)*. The first
request also loads the model into memory, so it can take 15 seconds or more; later ones take a second
or two.

A plain `http://` address is accepted only for a server on the same machine (`127.0.0.1`,
`localhost`). Anything else must be `https://`. To use Claude or OpenAI instead, choose the provider
and paste an API key. The key stays on the server: it is never sent to the browser or to plugins.

## 3. Suggest an excerpt and a meta description

Open a post in the editor, for example *How we brew a pour-over* from
[Tutorial 6](06-import-a-wordpress-site.md), and open the page settings (**Page**). Under
**Excerpt**, click **Suggest with AI**. After a few seconds a box appears:

> **SUGGESTION (REVIEW IT BEFORE USING IT)**
> Pour over coffee method: Prepare with 15 grams of coffee for 250 milliliters of water, then rinse
> the filter, make three slow pours.
>
> **Use** · **Try again** · **Dismiss**

**Use** puts the text in the field, with undo, autosave and the normal save path. **Try again** asks
for another suggestion. The **Meta description** field has the same button, and its suggestions
stay under 160 characters (*Learn how to enjoy perfect pour-over coffee.*). Save or publish the post
as usual to keep what you accepted.

## 4. Alt text needs a model that sees images

In **Admin → Media**, an image's details have a **Suggest with AI** button for the alt text. The
server sends a downscaled copy of the image to the model. It never sends private media.

`qwen2.5:1.5b` reads text only, so this request is refused with *The configured model does not accept
images. Choose a vision-capable model under Settings → AI to suggest alt text.* For alt text, configure
a model that accepts images: Claude, an OpenAI vision model, or a vision model in Ollama on a machine
with enough power. On a CPU-only server a small vision model like `moondream` is slow and its alt text
is often unusable, so plan for a GPU or a hosted model there.

## Good to know

- **Slow machines:** a provider on this machine (`127.0.0.1` or `localhost`) gets up to 5 minutes per
  request, a hosted one 60 seconds. Set `WORDJS_AI_TIMEOUT_MS` in the service's environment to change
  both. When a request runs out of time, the editor says so (*The AI provider took too long to
  answer…*).
- **Limits:** 20 suggestions per minute per user. The buttons appear only when a provider is
  configured. **Provider: Off** turns every AI feature off.
- **Untrusted text:** the draft is passed to the model as material, never as instructions, and the
  answer is cut down to one line of plain text. The worst a hostile draft can do is produce a bad
  suggestion, which you discard.
- **Plugins** can use the same provider only if an administrator grants them the `ai:use`
  permission. They get text back, never the key. See [ai-provider.md](../ai-provider.md).

---
*Tested on 2026-10-17 with Ollama and `qwen2.5:1.5b` on fresh Debian 12 installs, CPU only.

- **WordJS 2.6.0, in a browser, 4 cores:**
  - **Test connection:** connected; the first call took 15 s.
  - **Excerpt and meta description:** both suggestions were produced in about 2–3 s, and **Use**
    filled the excerpt field. The quoted suggestions are the real outputs from that run.
- **WordJS 2.7.0 release build, 2 cores:**
  - **Test connection:** connected in 13 s.
  - **Excerpt:** two suggestions came back after 65 s and 101 s, past the old 60-second limit, which
    no longer applies to a local model.
  - **Alt text with the text model:** refused with the message quoted in step 4.*
