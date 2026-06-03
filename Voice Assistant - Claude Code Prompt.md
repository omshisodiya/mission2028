# Claude Code prompt — integrate the Siri-style voice overlay

Drop `Voice Assistant Design.html` into your project, then paste the box below to Claude Code.

---

```
I have a working website with a functioning voice assistant (wake-word detection, speech
recognition, intent handling, and text-to-speech ALREADY WORK). Do NOT change any of that
logic. I only want to apply a NEW DESIGN + ANIMATION to the assistant's UI.

The design is fully specified in this file: ./Voice Assistant Design.html
Open it and treat it as the single source of truth for the look and motion.

IMPORTANT — it is NOT a page and NOT a button/FAB. It is a Siri-style full-screen OVERLAY:
- Invisible while the assistant is asleep. My page stays fully usable underneath.
- When my wake-word/voice fires, the assistant wakes and three layers come alive together:
    (a) AURORA curtains — soft, flowing, blurred ribbons of colour (saffron, gold, violet,
        cool blue, teal) that drift and undulate across the screen (northern-lights feel);
    (b) a CIRCULAR WAVEFORM — radial bars in a ring at screen centre that pulse with the
        voice, sending out expanding RIPPLE RINGS on amplitude peaks;
    (c) a soft edge GLOW framing the screen, plus a caption + transcript at the bottom.
- The page dims/blurs slightly behind it. Everything reacts to voice amplitude.
- Tinted with my site palette (gold #f0b54a + saffron/green + cool accents).

WHAT TO DO
1. Read ./Voice Assistant Design.html fully — the <style> block (especially .va-aurora +
   its auroraDrift keyframes, .va-glow, .va-rim, the centred .va-ring circular-waveform
   canvas, .va-dock, and the `body:not([data-state="idle"])` rules) and the driver <script>
   (the rAF loop that flows the aurora/gradient AND the drawRing() function that renders the
   circular radial waveform + ripple rings, plus the `VA` API at the bottom).
2. Add this overlay to my app as a GLOBAL, always-mounted layer (it lives at the app root,
   above everything, position:fixed, pointer-events:none). It is NOT a route/page. Keep ALL
   THREE visual layers — the aurora curtains, the circular waveform, and the edge glow.
   Remove the "faux page behind" markup and the preview switcher — those exist only so the
   design previews standalone.
3. The ENTIRE animation keys off ONE attribute: data-state on the overlay/body root =
   "idle" | "listening" | "thinking" | "speaking".  'idle' = asleep/hidden.
   Make my assistant set that attribute as its state changes:
     - wake-word fires           → VA.setState('listening')
     - recognition ends / sent   → VA.setState('thinking')
     - TTS starts                → VA.setState('speaking')
     - TTS ends / dismissed      → VA.setState('idle')
4. Wire my REAL audio + logic to the documented hooks (copy/recreate the `VA` object):
   - VA.setState('idle'|'listening'|'thinking'|'speaking')
   - VA.setAmplitude(0..1)  ← call EVERY animation frame from a Web Audio AnalyserNode:
       • while listening, analyse the mic stream;
       • while speaking, analyse the TTS audio output.
       Normalise RMS/average to 0..1. THIS is what makes the aurora breathe, the circular
       waveform pulse, and the ripple rings fire on peaks.
   - VA.setTranscript(text, isFinal) ← feed STT partials (isFinal=false shows a caret) and
       the final spoken reply (isFinal=true) so it reads like Siri's captions.
5. DELETE the "FAKE DEMO LOGIC" section (simulated amplitude, demo transcripts, switcher).

STRICT CONSTRAINTS
- Do NOT change my wake-word, speech recognition, intent/NLU, TTS, or API logic.
- Do NOT change any other page, route, style, or behavior on my site.
- Only add the overlay layer + the state/amplitude/transcript wiring.
- Respect prefers-reduced-motion (the reference already gates the flow animation).
- Reuse my existing CSS tokens if I have them (--accent etc.); the reference defines its own
  :root only because it's standalone. Keep the overlay pointer-events:none so it never
  blocks clicks on my page (add pointer-events only to any interactive dismiss control).

When done, show me all four states and confirm the aurora + circular waveform react to REAL
mic amplitude while listening and to REAL TTS amplitude while speaking, and that my page is
still fully clickable underneath while the overlay is visible.
```

---

## Notes for you (not part of the prompt)

- It's an **overlay that wakes on voice** — no page, no floating button. Your wake-word just
  calls `VA.setState('listening')` and the screen edges light up.
- The single most important wire is **`VA.setAmplitude()` fed from a real AnalyserNode every
  frame** — that's what makes the Siri glow breathe with your voice. The prompt tells Claude
  Code to add the analyser on both the mic (listening) and the TTS output (speaking) if you
  don't already expose a level.
- If your app is React/Vue/etc., tell Claude Code — ask it to mount the overlay once at the
  app root and translate the vanilla structure into your component idiom. The `data-state`
  contract and the `VA` hooks stay identical.
