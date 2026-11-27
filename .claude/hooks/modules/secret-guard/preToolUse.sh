#!/bin/bash
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "MultiEdit" || "$TOOL_NAME" == "NotebookEdit" ]]; then
    CONTENT=$(echo "$INPUT" | jq -r '.tool_input | .content // .new_string // .new_source // (.edits[]?.new_string) // empty')
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
    FILE_PATH="${FILE_PATH//\\//}"
    FILE_NAME="${FILE_PATH##*/}"
    if [[ "$FILE_NAME" == ".env" || "$FILE_NAME" == .env.* ]]; then
        exit 0
    fi
    PATTERNS=(
        "AKIA[0-9A-Z]{16}"
        "ghp_[A-Za-z0-9]{36}"
        "ghs_[A-Za-z0-9]{36}"
        "github_pat_[A-Za-z0-9_]{82}"
        "sk-[A-Za-z0-9]{48}"
        "sk-proj-[A-Za-z0-9_-]{50,}"
        "-----BEGIN[[:space:]]*(RSA[[:space:]]*|EC[[:space:]]*|OPENSSH[[:space:]]*)?PRIVATE KEY-----"
        "xox[baprs]-[A-Za-z0-9-]+"
    )
    for pattern in "${PATTERNS[@]}"; do
        if printf '%s\n' "$CONTENT" | grep -qE -- "$pattern"; then
            echo "[Hook] Potential secret detected in $FILE_NAME. Pattern: $pattern" >&2
            echo "Possible secret or credential detected in the file content. Review before writing."
            exit 2
        fi
    done
fi
exit 0
