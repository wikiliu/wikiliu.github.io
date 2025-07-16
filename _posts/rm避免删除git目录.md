

rm() {
  local top_level
  top_level="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  local cwd="$(pwd)"

  if [[ -n "$top_level" && "$cwd" == "$top_level" && -d ".git" ]]; then
    local all_files=(*)
    local targets=("$@")

    if [ "${#targets[@]}" -ge "${#all_files[@]}" ]; then
      local matched_all=true
      for f in "${all_files[@]}"; do
        local found=false
        for t in "${targets[@]}"; do
          [[ "$f" == "$t" ]] && found=true
        done
        if ! $found; then
          matched_all=false
          break
        fi
      done

      if $matched_all; then
        echo "⛔️ Dangerous operation blocked: attempting to delete all files in git root."
        echo "📍 Current directory: $cwd"
        echo "💡 Please navigate to a subdirectory or specify files explicitly."
        return 1
      fi
    fi
  fi

  command rm "$@"
}

