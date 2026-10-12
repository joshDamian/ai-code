# Running Bench on a VPS

Bench runs on the server as your own user. Your devices reach it only over your tailnet, and nothing is opened to the internet. Each device pairs once.

Allow about 30 minutes. The commands assume Ubuntu 24.04 or Debian 12 on x64 or ARM, with 2 GB of RAM or more.

## 1. The server

Create a VPS (Hetzner, DigitalOcean, Linode and so on) and SSH in. Make a user for Bench rather than working as root:

```bash
adduser dev
usermod -aG sudo dev
su - dev
```

Install the system packages. `build-essential` and `python3` are needed to compile the terminal's native module:

```bash
sudo apt update
sudo apt install -y git curl build-essential python3
```

Install Node.js 22. Use nvm, so the node path stays under your home directory:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
node --version   # v22.13 or later
```

## 2. Claude Code and git credentials

Install Claude Code and log in. The login prints a URL: open it on your laptop or phone, approve, and paste the code back.

```bash
npm install -g @anthropic-ai/claude-code
claude          # then /login, follow the link, then /exit
```

Bench's sessions use this login. If you use DeepSeek, OpenRouter or Fireworks instead or as well, export their keys in `~/.bashrc` **before** step 4, so the service picks them up:

```bash
echo 'export DEEPSEEK_API_KEY=sk-...' >> ~/.bashrc && source ~/.bashrc
```

Set up git and GitHub so tasks can commit, push and open pull requests:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
sudo apt install -y gh      # or follow https://github.com/cli/cli#installation
gh auth login               # choose HTTPS and "Login with a web browser"
gh auth setup-git           # lets git push with the same login
```

## 3. Tailscale

Install Tailscale and join your tailnet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # open the printed link and approve the machine
sudo tailscale set --operator=$USER    # lets `bench share` run without sudo
```

In the Tailscale admin console (login.tailscale.com):

1. **DNS:** turn on MagicDNS and **HTTPS Certificates**. `bench share` needs HTTPS, and so do push notifications and home-screen install on the phone.
2. **Machines:** optionally disable key expiry for this machine, so it doesn't drop off the tailnet after 180 days.

Install the Tailscale app on your phone and Mac too, logged into the same tailnet.

## 4. Bench

Clone and install it as a service:

```bash
git clone https://github.com/joshDamian/ai-code.git ~/bench-src
cd ~/bench-src
npm install
bin/install --service
sudo loginctl enable-linger $USER    # keeps the service running when you log out
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

Check that everything is in place:

```bash
bench service status    # installed: true, running: true
bench doctor            # git, node, claude, gh, tailscale, terminal, providers
```

The server listens on `127.0.0.1:4317` only. Do not open that port in a firewall.

## 5. Your projects

The simplest way is from the app: **Add project → Clone** lists your GitHub repositories (through the `gh` login from step 2) and clones the one you pick into `~/bench-projects`. From the shell instead:

```bash
mkdir -p ~/bench-projects && cd ~/bench-projects
git clone https://github.com/you/your-repo.git
bench add ~/bench-projects/your-repo
```

Copy over any `.env` or other untracked files the projects need. They are not in git:

```bash
# from your Mac
scp ~/Code/your-repo/.env dev@<vps>:~/bench-projects/your-repo/.env
```

If a project has dependencies, install them once in the checkout (`npm install` and so on). Task worktrees link to the checkout's `node_modules`.

## 6. Your devices

Publish Bench on your tailnet and pair a device:

```bash
bench share     # prints https://<machine>.<tailnet>.ts.net
bench pair      # prints a QR code and a one-time link, valid 10 minutes
```

On your phone, with Tailscale connected:

1. Scan the QR code or open the link, name the device, and tap **Pair**.
2. Add it to the home screen. On iOS that's Safari → Share → Add to Home Screen; on Android it's Chrome → menu → Install app.
3. Open Bench from the home screen and go to **Settings → Notifications → Turn on**.

Repeat `bench pair` for each device: your Mac, a tablet and so on. A device stays paired until you unpair it in **Settings → Devices**.

## Updating

```bash
cd ~/bench-src
git pull
npm install
bin/install --service
```

`bin/install` builds a new release and restarts the service. Sessions in the middle of a turn are stopped; their conversations resume on the next message. From a paired device, **Settings → Server → Restart server** restarts without SSH.

## When something is wrong

| Symptom | Check |
|---|---|
| `bench service status` says not running | `journalctl --user -u bench -n 50` |
| Sessions fail with an auth error | Run `claude` on the server, then `/login` |
| The pairing link has no address | Run `bench share`, and check MagicDNS and HTTPS are on in the Tailscale console |
| The phone can't reach the link | Is Tailscale connected on the phone? Does `tailscale serve status` show port 443? |
| Terminals don't open | `bench doctor` reports the terminal. Install `build-essential python3`, then re-run `bin/install --service` |
| A hosted provider says its key is missing | Export the key in `~/.bashrc`, then re-run `bin/install --service`, which copies it into the service |
| The service stops when you log out | `sudo loginctl enable-linger $USER` |
