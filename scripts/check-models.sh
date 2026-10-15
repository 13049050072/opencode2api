#!/usr/bin/env bash
set -u

BASE_URL=${BASE_URL:-http://localhost:8080}
CONFIG=${CONFIG:-config.json}
REQUEST_TIMEOUT=${REQUEST_TIMEOUT:-60}
CONFIRM=false

if [[ ${1:-} == "--yes" ]]; then
	CONFIRM=true
elif [[ $# -gt 0 ]]; then
	printf 'Usage: %s [--yes]\n' "$0" >&2
	exit 2
fi

if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
	printf 'This script requires curl and jq.\n' >&2
	exit 1
fi

if [[ -z ${API_KEY:-} ]]; then
	if [[ ! -r "$CONFIG" ]]; then
		printf 'Cannot read config file: %s\n' "$CONFIG" >&2
		exit 1
	fi
	API_KEY=$(jq -r '.server_keys[]? | select(type == "string" and length > 0)' "$CONFIG" | head -n 1)
	if [[ -z "$API_KEY" ]]; then
		printf 'No server key found in %s; set API_KEY explicitly.\n' "$CONFIG" >&2
		exit 1
	fi
fi

BASE_URL=${BASE_URL%/}
models_file=$(mktemp)
response_file=$(mktemp)
trap 'rm -f "$models_file" "$response_file"' EXIT

if ! curl -sS --fail-with-body "$BASE_URL/v1/models" \
	-H "Authorization: Bearer $API_KEY" -o "$models_file"; then
	printf 'Could not fetch models from %s/v1/models\n' "$BASE_URL" >&2
	cat "$models_file" >&2
	exit 1
fi

if ! jq -e '.data | type == "array"' "$models_file" >/dev/null; then
	printf 'Unexpected response from /v1/models:\n' >&2
	cat "$models_file" >&2
	exit 1
fi

model_count=$(jq '.data | length' "$models_file")
if [[ "$model_count" -eq 0 ]]; then
	printf 'No models were returned by %s/v1/models\n' "$BASE_URL"
	exit 0
fi

if [[ "$CONFIRM" != true ]]; then
	printf 'This will send one short inference request to each of %s model(s). Paid models may consume quota. Continue? [y/N] ' "$model_count"
	read -r answer
	case "$answer" in
		y|Y|yes|YES) ;;
		*) printf 'Cancelled.\n'; exit 0 ;;
	esac
fi

passed=0
failed=0
skipped=0

while IFS=$'\t' read -r model protocol; do
	case "$protocol" in
		chat)
			path=/v1/chat/completions
			body=$(jq -cn --arg model "$model" '{model:$model,messages:[{role:"user",content:"Reply with OK."}],max_tokens:8}')
			;;
		responses)
			path=/v1/responses
			body=$(jq -cn --arg model "$model" '{model:$model,input:"Reply with OK.",max_output_tokens:8}')
			;;
		anthropic)
			path=/v1/messages
			body=$(jq -cn --arg model "$model" '{model:$model,max_tokens:8,messages:[{role:"user",content:"Reply with OK."}]}')
			;;
		systemone)
			path=/v1/systemone
			body=$(jq -cn --arg model "$model" '{model:$model,state:"1 + 1 = 2",questions:{arithmetic:{type:"noul",instructions:"Is 1 + 1 equal to 2?"}}}')
			;;
		*)
			printf 'SKIP  %s (unsupported protocol: %s)\n' "$model" "$protocol"
			skipped=$((skipped + 1))
			continue
			;;
	esac

	request_args=(-H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json')
	if [[ "$protocol" == anthropic ]]; then
		request_args+=(-H 'anthropic-version: 2023-06-01')
	fi

	if status=$(curl -sS --connect-timeout 5 --max-time "$REQUEST_TIMEOUT" \
		-o "$response_file" -w '%{http_code}' -X POST "$BASE_URL$path" \
		"${request_args[@]}" -d "$body"); then
		curl_ok=true
	else
		curl_ok=false
		status=${status:-000}
	fi

	if [[ "$curl_ok" == true && "$status" =~ ^2[0-9][0-9]$ ]] \
		&& jq -e 'type == "object" and (has("error") | not)' "$response_file" >/dev/null 2>&1; then
		printf 'PASS  %s (%s, HTTP %s)\n' "$model" "$protocol" "$status"
		passed=$((passed + 1))
	else
		message=$(jq -r '.error.message // .message // empty' "$response_file" 2>/dev/null | head -c 200)
		printf 'FAIL  %s (%s, HTTP %s)' "$model" "$protocol" "${status:-000}"
		if [[ -n "$message" ]]; then
			printf ': %s' "$message"
		fi
		printf '\n'
		failed=$((failed + 1))
	fi
done < <(jq -r '.data[] | [.id, (.native_protocol // "chat")] | @tsv' "$models_file")

printf '\nSummary: %s passed, %s failed, %s skipped (total %s)\n' \
	"$passed" "$failed" "$skipped" "$model_count"
if [[ "$failed" -gt 0 || "$skipped" -gt 0 ]]; then
	exit 1
fi