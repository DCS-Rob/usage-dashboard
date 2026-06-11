# Usage Dashboard Onboarding

This guide explains how to start or join a Usage Dashboard without needing to know the internals.

## The Short Version

Usage Dashboard has two parts:

- **Chrome extension**: reads usage from the AI account that is logged in inside that Chrome profile.
- **PWA/dashboard**: shows synced data from all connected profiles.

Important rule:

> One Chrome profile can track one active ChatGPT/Claude session per provider.

If Sorin, Kevin and Rob each have their own ChatGPT account, use separate Chrome profiles or separate computers.

## Start Your Own Dashboard

Use this when you want your own separate sync space.

1. Open the Usage Dashboard extension.
2. Open **Guided setup**.
3. Choose **Own dashboard**.
4. Enter a clear profile name, for example `Rob - Personal`.
5. Click **Create my dashboard**.
6. Open the provider usage pages from the header shortcuts:
   - Claude: `https://claude.ai/settings/usage`
   - ChatGPT: the ChatGPT analytics/usage page
7. Wait for the extension to sync the account.

The first cards appear once the usage pages have been loaded in that Chrome profile.

## Join An Existing Dashboard

Use this when someone shared an invite link.

1. Open Chrome with the profile that should contribute data.
2. Make sure the Usage Dashboard extension is installed in this Chrome profile.
3. Go to `chrome://extensions`.
4. Click **Reload** on Usage Dashboard.
5. Open the invite link.
6. Accept the invite.
7. Log in to ChatGPT/Claude in this Chrome profile.
8. Open the usage page for that provider.

If the invite opens the PWA instead of the extension overlay, follow the install instructions shown there. The PWA can detect whether the extension is already installed in the current Chrome profile after the extension has been updated at least once.

## Add Another Account Or Person

Use this for Sorin, Kevin, or a second account from the same person.

1. In the main dashboard, open **Profiles & Connection**.
2. Click **Guided setup**.
3. Choose **Add account**.
4. Enter a label, for example `Sorin - ChatGPT`.
5. Choose the provider.
6. Click **Prepare invite**.
7. Copy the invite link.
8. Open a separate Chrome profile for that account.
9. Load or reload the extension in that Chrome profile.
10. Open the invite link and accept.
11. Log in to the correct AI account.
12. Open the usage page.

The card should appear in **All profiles** after the first successful scrape.

## Label A Subscription Card

In **All profiles**, each provider card has a small edit icon.

1. Click the pen icon next to the card label.
2. Enter a clear name, for example `Sorin - ChatGPT`.
3. Press Enter or click outside the field.

Labels are synced through `dashboardConfig.labels`, so other dashboards see the same names.

## What The Header Indicators Mean

- **Extension**: you are using the Chrome extension dashboard. This profile can scrape and contribute data.
- **PWA**: you are using the web/mobile dashboard. It can read synced data, but cannot scrape accounts by itself.
- **PWA Synced**: GitHub Pages is running the same app version as the current dashboard.
- **PWA Behind**: GitHub Pages is still deploying or running an older app version. Wait a minute and refresh.

## Troubleshooting

### I accepted an invite but I see a login screen

Reload the extension in this Chrome profile:

1. Open `chrome://extensions`.
2. Find Usage Dashboard.
3. Click **Reload**.
4. Open the invite link again.

### The new account card does not appear

Check:

- the correct Chrome profile is open;
- the extension is installed and reloaded there;
- the account is logged in on the provider website;
- the provider usage page has been opened at least once;
- the main dashboard is set to **All profiles**.

### The card shows the wrong account

The scraper reads the account currently logged in inside that Chrome profile. Log out of the wrong account, log in to the correct one, open the usage page again, then sync.

### Can one Chrome profile track multiple ChatGPT accounts?

No. Chrome has one active session per site per profile. Use separate Chrome profiles for separate ChatGPT accounts.

### Can we use one shared Chrome account for everyone?

Technically possible, but not recommended. It mixes cookies, sessions, passwords, extension storage and account state. Use one Chrome profile per person/account instead.
