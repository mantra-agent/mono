# Agent — Mobile Voice App

Expo React Native companion app for Agent on Meta Ray-Ban smart glasses. Voice-first: the glasses act as a Bluetooth headset, and this app bridges ElevenLabs Conversational AI to the Mantra server.

## Prerequisites

- Node.js 18+
- macOS with Xcode 15+ (for iOS builds)
- [EAS CLI](https://docs.expo.dev/eas/): `npm install -g eas-cli`
- iPhone with Meta AI app installed
- Meta Ray-Ban glasses paired via Meta AI app

## Development Setup

```bash
cd mobile
npm install

# Create native project files (required for dev client builds)
npx expo prebuild --platform ios

# Start the dev server
npx expo start --dev-client
```

For the first standalone install, create a preview build:

```bash
eas build --platform ios --profile preview
```

Install the resulting `.ipa` on your device via Xcode or Apple Configurator.

## Building with EAS

```bash
# Development client (requires `npx expo start --dev-client`)
eas build --platform ios --profile development

# Preview standalone (internal testing, no dev tools, points at production)
eas build --platform ios --profile preview

# Production
eas build --platform ios --profile production
```

## Installing on Device

1. Run `eas build` with the desired profile
2. Download the build artifact from the EAS dashboard
3. Install via Xcode Devices & Simulators, or scan the QR from EAS

## Running Locally

These steps are only for the development-client profile, not preview/production standalone builds.

1. Start the dev server: `npx expo start --dev-client`
2. Open the dev client app on your iPhone
3. Scan the QR code or enter the URL manually
4. Tap the mic button to start a voice session

## Configuration

On first launch, go to Settings (gear icon) to configure:

- **Agent ID**: Your ElevenLabs agent ID (pre-configured in `src/config.ts`)
- **Server URL**: Your Mantra server URL (pre-configured)

## Glasses Pairing

1. Open Meta AI app on iPhone
2. Go to Devices → pair your Ray-Ban glasses
3. Enable Developer Mode: Settings → your device → Developer Mode toggle
4. Disable "Hey Meta" wake word (optional, doubles battery life): Settings → your device → Hey Meta → Off

Once paired, the glasses act as a standard Bluetooth headset. When a voice session is active in the Agent app, audio routes through the glasses automatically.

## Siri Shortcut Setup

Create a hands-free way to start Agent:

1. Open the **Shortcuts** app on iPhone
2. Tap **+** to create a new shortcut
3. Add action: **Open URLs**
4. Set URL to: `agentglasses://start`
5. Name the shortcut: **Agent**
6. Say: **"Hey Siri, Agent"** to launch

### Action Button (iPhone 15 Pro+)

1. Go to iPhone Settings → Action Button
2. Set to: **Shortcut**
3. Select the "Agent" shortcut created above
4. Press the Action Button to start a voice session instantly

## Meta Ray-Ban Display — Web App Registration

The Zero Tab display surface runs as a standalone web app on the Ray-Ban Display's right-lens screen (600×600px additive display). This is independent of the voice app — both work together but ship separately.

### Registration Steps

1. Open the **Meta AI** app on your paired iPhone
2. Navigate to: **Devices → [Your Display Glasses] → Web apps → Add**
3. Configure:
   - **Name**: `Agent`
   - **URL**: `https://mono-prod-8d22.up.railway.app/glasses`
4. Save. The web app is now registered on your glasses.

### Requirements

- Ray-Ban Display glasses (not standard Ray-Ban Meta)
- Neural Band paired for D-pad input
- Glasses paired with Developer Mode enabled
- The `/glasses` endpoint must be accessible over HTTPS (Railway provides this)

### Display Constraints

- 600×600px viewport, right lens only
- Additive display: black = transparent, white = visible
- D-pad navigation via Neural Band EMG (maps to arrow key events)
- Battery-conscious: the surface updates on 60-second intervals, not continuous streaming
- Foreground only: no background push. Updates queue and render when the display activates.

### Testing Without Hardware

Open `https://mono-prod-8d22.up.railway.app/glasses` in any browser for a pixel-perfect preview of the display surface. The `/zero` route in the main app provides the same preview with dev tools (JSON inspector, Cortex reasoning trace).
