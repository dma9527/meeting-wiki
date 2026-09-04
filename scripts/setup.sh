#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${MEETING_WIKI_DATA_DIR:-$HOME/.meeting-wiki}"
WITH_MLX=1
[ "${1:-}" = "--no-mlx" ] && WITH_MLX=0

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Meeting Wiki desktop v0.1 currently supports macOS only." >&2
  exit 1
fi

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js 20+ is required" >&2; exit 1; }
command -v rec >/dev/null || { echo "SoX is required: brew install sox" >&2; exit 1; }

mkdir -p "$DATA_DIR" "$HOME/.local/bin"
python3 -m venv "$DATA_DIR/venv"
"$DATA_DIR/venv/bin/python" -m pip install -q --upgrade "pip==26.2.1"
if [ "$WITH_MLX" -eq 1 ]; then
  "$DATA_DIR/venv/bin/pip" install -q "$ROOT[mlx]"
else
  "$DATA_DIR/venv/bin/pip" install -q "$ROOT"
fi

if [ ! -f "$DATA_DIR/config.toml" ]; then
  cp "$ROOT/config.example.toml" "$DATA_DIR/config.toml"
  chmod 600 "$DATA_DIR/config.toml"
fi

cat > "$HOME/.local/bin/meeting-wiki" <<EOF
#!/usr/bin/env bash
exec "$DATA_DIR/venv/bin/meeting-wiki" "\$@"
EOF
cat > "$HOME/.local/bin/meeting-wiki-mcp" <<EOF
#!/usr/bin/env bash
exec "$DATA_DIR/venv/bin/meeting-wiki-mcp" "\$@"
EOF
chmod +x "$HOME/.local/bin/meeting-wiki" "$HOME/.local/bin/meeting-wiki-mcp"

(cd "$ROOT/desktop" && npm install --silent)

# Optional Kiro registration. Meeting Wiki never requires Kiro or MCP.
KIRO_CONFIG="$HOME/.kiro/settings/mcp.json"
if [ -f "$KIRO_CONFIG" ]; then
  python3 - "$KIRO_CONFIG" "$DATA_DIR" <<'PYEOF'
import json, sys
path, data_dir = sys.argv[1:]
data = json.load(open(path))
data.setdefault("mcpServers", {})["meeting-wiki"] = {
    "command": f"{data_dir}/venv/bin/meeting-wiki-mcp",
    "args": [],
    "disabled": False,
    "autoApprove": [
        "meeting_wiki_search", "meeting_wiki_read_page",
        "meeting_wiki_list_recent", "meeting_wiki_action_items",
    ],
}
json.dump(data, open(path, "w"), indent=2)
open(path, "a").write("\n")
print("Registered optional meeting-wiki MCP server in Kiro.")
PYEOF
fi

cat <<EOF
Meeting Wiki installed locally.

1. Edit: $DATA_DIR/config.toml
2. If using Ollama: ollama serve && ollama pull <your configured model>
3. Add ~/.local/bin to PATH if needed.
4. Validate: meeting-wiki doctor
5. Start desktop in development: cd "$ROOT/desktop" && npm start

No AWS account, login, API key, Kiro, or MCP client is required for the default
local setup.
EOF
