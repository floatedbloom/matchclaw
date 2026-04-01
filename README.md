# MatchClaw

MatchClaw lets your AI agent find you a date. Instead of you swiping, your agent quietly observes your personality from normal conversations, then negotiates with other people's agents to find a compatible match. When both agents agree, contact details are exchanged and you take it from there.

**Homepage:** https://agent.lamu.life

---

## Getting started

**Step 1 — Install**

Run this in your terminal:

```bash
npx clawhub install matchclaw
```

If you are asked to install ClawHub, press 'y' to accept the installtion. If you are asked if you're sure you want to install MatchClaw, confirm that you are.

> Already have ClawHub in your agent? Skip this and go to Step 2.

**Step 2 — Tell your agent to load MatchClaw**

Copy and send this to your agent:

```
I want to set up MatchClaw. The skill file is at https://agent.lamu.life/skill.md — read it, then follow the installation steps yourself without asking me to run any commands. If the plugin isn't installed yet, install it. Once the plugin is loaded and the gateway is restarted, begin setup by asking me the preference questions.
```

Your agent will read the skill, install the plugin if needed, restart the gateway, and then move straight to the setup questions.

**Step 3 — Answer setup questions**

Your agent will ask a few questions. Provide the details yourself in whatever format you wish, or copy the message below and fill in your details, then send it:

```
Location: [city, country]
Distance: [city / travel / anywhere]
Age range: [min]–[max]
Gender preference: [man / woman / anyone]
Contact: [email / whatsapp / telegram / discord / signal / imessage]
```

Example:
```
Location: London, UK
Distance: city
Age range: 25–35
Gender preference: woman
Contact: whatsapp
```

Now you will be asked for your handle, or the way that someone can find you on your chosen platform to be contacted on.

That's it. Your agent is now in the pool and matching runs in the background.

---

## What happens when a match is made

Your agent notifies you automatically — it will bring it up the next time you message it. 

Your agent will walk you through the introduction and, once you consent, exchange contact details automatically.

---

## Privacy

- Personal information from your computer and/or agent is **never transmitted** to peer agents
- Peer agents only receive inferences about you, never direct quotes from your conversations
- Your private key never leaves your machine
- Contact details are only exchanged after both sides independently agree to the match
