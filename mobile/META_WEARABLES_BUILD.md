# Meta Wearables DAT iOS build configuration

The Meta/Wearables source of truth is the web Integration page:

```text
Integrations → Meta → Wearables / Device Access Toolkit
```

The mobile app is configured for the first Agent glasses validation path by default:

- Bundle ID: `com.oniops.firstglasses`
- Universal link host: `raymondkallmeyer.com`
- URL scheme callback: `agentglasses://`
- Associated Domains entitlement: off by default for Developer Mode
- DAT mode: Developer Mode
- MWDAT `MetaAppID`: `0`

Developer Mode is the correct first build path while Ray validates on his iPhone and Ray-Ban Display glasses. Official DAT docs state Developer Mode registration is always allowed with `MetaAppID = 0`; production/registered-app mode requires release-channel eligibility and the Meta Application ID. The first Developer Mode build uses the URL-scheme callback path and does not require Apple's Associated Domains entitlement.

## Registered-app build env

Do not hardcode Ray's Meta Application ID in the repo. When the Integration page has the registered-app values, export them into the EAS build environment/secrets and build with:

```bash
META_WEARABLES_DEVELOPER_MODE=false
META_WEARABLES_APP_ID=<Meta Application ID from Integrations → Meta → Wearables>
```

Optional override if Meta provides a full plist dictionary:

```bash
META_WEARABLES_MWDAT_JSON='{"AppLinkURLScheme":"agentglasses://","MetaAppID":"<id>","ClientToken":"<token>","TeamID":"<team>"}'
```

`META_WEARABLES_MWDAT_JSON` must be JSON for the value under the `MWDAT` Info.plist key, not raw XML.

## Apple app-site association

This is not required for the first Developer Mode build. Enable it only after the Apple App ID/provisioning profile has the Associated Domains capability:

```bash
META_WEARABLES_ENABLE_ASSOCIATED_DOMAINS=true
```

Then `https://raymondkallmeyer.com/.well-known/apple-app-site-association` must authorize the app ID once Apple Team ID is known:

```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appIDs": [
          "<APPLE_TEAM_ID>.com.oniops.firstglasses"
        ],
        "components": [
          {
            "/": "*",
            "comment": "Allow Agent iOS universal links for Meta Wearables DAT registration."
          }
        ]
      }
    ]
  }
}
```

Serve it as `application/json` with no `.json` extension.
