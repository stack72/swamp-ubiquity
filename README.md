# UniFi Dream Machine Traffic Monitor

A [swamp](https://github.com/systeminit/swamp) repository that collects and monitors traffic data from a Ubiquiti UniFi Dream Machine (UDM).

## What It Does

The `@stack72/unifi-traffic` extension model connects to your UDM and collects:

- **Site Traffic** - Hourly WAN and WLAN traffic totals for the past 24 hours
- **Client Traffic** - Per-device usage, signal strength, and connection details
- **DPI Stats** - Deep packet inspection category breakdown (when available)

## Prerequisites

- [swamp](https://github.com/systeminit/swamp) installed
- A UniFi Dream Machine (UDM, UDM Pro, UDM SE, etc.)
- Either local network access to the UDM or a Ubiquiti cloud API key

## Setup

### 1. Initialize the repository

If starting fresh:

```bash
swamp repo init
```

### 2. Create a vault for credentials

```bash
swamp vault create secrets
```

### 3. Choose your connection mode

The model supports two modes: **local** (direct connection to UDM) and **cloud** (via Ubiquiti's cloud API).

#### Option A: Local Mode

Connects directly to the UDM over your local network. Requires a local admin user on the UDM.

**Create the local admin user on your UDM:**
1. Open the UniFi app or web UI
2. Go to Settings > Admins & Users
3. Create a new admin user (e.g. `swamp`) with SuperAdmin role
4. Set access to "Local Access Only"

**Store the password:**
```bash
swamp vault put secrets UDM_PASSWORD
# Enter the password when prompted
```

**Create the model instance:**
```bash
swamp model create @stack72/unifi-traffic udm-traffic
```

**Configure the global arguments:**
```bash
swamp model edit udm-traffic
```

Set the `globalArguments` section in the definition:
```yaml
globalArguments:
  mode: "local"
  host: "192.168.1.1"
  username: "swamp"
  password: ${{ vault.get(secrets, UDM_PASSWORD) }}
  site: "default"
```

> Replace `192.168.1.1` with your UDM's IP address if different.

#### Option B: Cloud Mode

Connects via the Ubiquiti cloud API. Provides better device name resolution (fingerprint-based names) but requires an API key.

**Get your API key:**
1. Go to https://unifi.ui.com
2. Click your profile icon > Account Settings
3. Under API Keys, generate a new key

**Store the API key:**
```bash
swamp vault put secrets UNIFI_API_KEY
# Enter the API key when prompted
```

**Create the model instance:**
```bash
swamp model create @stack72/unifi-traffic udm-traffic
```

**Configure the global arguments:**
```bash
swamp model edit udm-traffic
```

Set the `globalArguments` section in the definition:
```yaml
globalArguments:
  mode: "cloud"
  apiKey: ${{ vault.get(secrets, UNIFI_API_KEY) }}
  site: "default"
```

#### Option C: Both (Recommended)

Use cloud mode with local credentials as fallback. Cloud mode provides better device name resolution by using the v2 API for fingerprint-based display names.

```bash
swamp vault put secrets UDM_PASSWORD
swamp vault put secrets UNIFI_API_KEY
```

```bash
swamp model create @stack72/unifi-traffic udm-traffic
```

Then configure the global arguments:
```bash
swamp model edit udm-traffic
```

Set the `globalArguments` section in the definition:
```yaml
globalArguments:
  mode: "cloud"
  host: "192.168.1.1"
  username: "swamp"
  password: ${{ vault.get(secrets, UDM_PASSWORD) }}
  site: "default"
  apiKey: ${{ vault.get(secrets, UNIFI_API_KEY) }}
```

### 4. Collect data

```bash
swamp model method run udm-traffic collect
```

### 5. View the results

```bash
# View the latest collection
swamp model get udm-traffic --json

# View collected data
swamp data list udm-traffic
```

## Output

### Site Traffic

Hourly breakdown of the past 24 hours including:
- WAN upload/download bytes
- WLAN bytes
- Number of connected clients

### Client Traffic

Per-device snapshot including:
- Device name (resolved from multiple sources)
- IP and MAC address
- Upload/download bytes and current rate
- WiFi signal strength (dBm)
- SSID and network
- Top clients by usage percentage

### DPI Stats

Traffic categories (e.g. Streaming, Social Media, Gaming) when Deep Packet Inspection is enabled on the UDM under Settings > Traffic Management > Traffic Identification.

## Notes

- **Local mode** uses `curl` under the hood to handle the UDM's self-signed TLS certificate
- **Cloud mode** discovers your UDM's host ID and site ID automatically from the API
- Device names are resolved from multiple sources: user-assigned names, hostnames, and (in cloud mode) Ubiquiti's device fingerprint database
- The model writes a `log` file with collection details for debugging
