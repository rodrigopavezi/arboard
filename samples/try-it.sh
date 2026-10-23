#!/usr/bin/env bash
# Cria um canal de demonstração com a foto, o vídeo e o recado de voz de exemplo,
# publica também no Nostr, e — se você quiser — testa um nome legível (ArNS).
#
#   ./samples/try-it.sh                      testnet: grátis, apagado em ~3 dias
#   ./samples/try-it.sh --yes                testnet, sem perguntas; pula o nome
#   ./samples/try-it.sh --name canal-demo-123 [--topup 0.01]
#                                            testa também o nome (mín. 8 caracteres)
#   ./samples/try-it.sh --no-name            não oferece o teste do nome
#
#   ./samples/try-it.sh --mainnet            canal de teste REAL e PERMANENTE no Arweave.
#                                            Texto, foto e recado de voz são grátis (até 105 KiB).
#   ./samples/try-it.sh --mainnet --with-video
#                                            inclui o vídeo (pago, ETH de verdade)
#   ./samples/try-it.sh --mainnet --yes      sem perguntas (só o que é grátis)
#
# Precisa de: Node 18+, ffmpeg, e `npm install` feito na pasta do arboard.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
AB=(node "$ROOT/arboard.mjs")
YES=0; NAME=""; NO_NAME=0; TOPUP=""; NETWORK="testnet"; WITH_VIDEO=""
GAS_RESERVE="${GAS_RESERVE:-0.0004}"   # ETH left on the wallet for the transfer's gas

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1; shift ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --no-name) NO_NAME=1; shift ;;
    --topup) TOPUP="${2:-}"; shift 2 ;;
    --mainnet) NETWORK="mainnet"; shift ;;
    --with-video) WITH_VIDEO=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 1 ;;
  esac
done
INTERACTIVE=0; [[ $YES -eq 0 && -t 0 ]] && INTERACTIVE=1

if [[ "$NETWORK" == "mainnet" ]]; then
  DIR="${DEMO_DIR:-$PWD/canal-demo-mainnet}"
  ETH_LABEL="ETH (de verdade)"; NAME_HOST="turbo-gateway.com"
  # On mainnet, the video is paid; include it only when asked.
  [[ -z "$WITH_VIDEO" ]] && WITH_VIDEO=0
else
  DIR="${DEMO_DIR:-$PWD/canal-demo-arweave}"
  ETH_LABEL="Sepolia ETH (ETH de teste, sem valor)"; NAME_HOST="ar-io.dev"
  WITH_VIDEO=1
fi

command -v node >/dev/null || { echo "falta o Node.js (18 ou mais novo)" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "falta o ffmpeg" >&2; exit 1; }
[[ -d "$ROOT/node_modules/@ardrive/turbo-sdk" ]] || { echo "rode antes: (cd \"$ROOT\" && npm install)" >&2; exit 1; }

# true when the wallet has more than the amount (the rest pays for gas)
has_eth() { [[ -n "$1" && -n "$2" ]] && node -e "process.exit(Number(process.argv[1]) > Number(process.argv[2]) ? 0 : 1)" "$1" "$2"; }
topup_flags() { [[ "$NETWORK" == "mainnet" ]] && echo "--yes" || true; }
skip_name_msg() {
  echo "Pulando a compra do nome. Para testar depois, dentro de $DIR:"
  echo "  node \"$ROOT/arboard.mjs\" funds            # confere se o ETH chegou"
  echo "  node \"$ROOT/arboard.mjs\" topup ${2:-0.01} $(topup_flags)"
  echo "  node \"$ROOT/arboard.mjs\" name buy $1 --yes"
}
json_get() { node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=j[process.argv[1]];console.log(v===null||v===undefined?'':v)" "$1"; }

if [[ "$NETWORK" == "mainnet" ]]; then
  cat <<'EOF'
ATENÇÃO — isto publica um canal de teste na MAINNET do Arweave:
  • é PERMANENTE: nada do que for publicado pode ser apagado, nunca;
  • é público: qualquer pessoa com o link vê;
  • texto, foto e recado de voz são grátis (cada arquivo cabe em 105 KiB);
    o vídeo e o nome legível são pagos com ETH de verdade e só entram se você pedir;
  • uma carteira e uma chave Nostr novas são criadas só para este teste;
  • o serviço de envio e os relays veem o IP desta conexão (use VPN se importar).
O conteúdo é só o de exemplo (sem dados seus).
EOF
  if [[ $INTERACTIVE -eq 1 ]]; then
    read -r -p "Para continuar, digite 'permanente': " ans
    [[ "$ans" == "permanente" ]] || { echo "Cancelado."; exit 0; }
  elif [[ $YES -ne 1 ]]; then
    echo "Sem terminal para confirmar: rode com --mainnet --yes para publicar." >&2; exit 1
  fi
else
  cat <<'EOF'
Isto publica um canal de demonstração na testnet do Arweave:
  • grátis e sem cadastro — uma carteira nova é criada só para este canal;
  • qualquer pessoa com o link vê o conteúdo; ele some em ~3 dias;
  • as notas vão para relays Nostr reais, com uma chave nova só para este teste;
  • o serviço de envio e os relays veem o IP desta conexão (use VPN se importar).
EOF
  if [[ $YES -eq 0 && -z "$NAME" ]]; then
    read -r -p "Continuar? [s/N] " ans
    [[ "$ans" =~ ^[sSyY] ]] || { echo "Cancelado."; exit 0; }
  fi
fi

if [[ ! -f "$DIR/channel.json" ]]; then
  "${AB[@]}" init "$DIR" --title "Canal de demonstração" \
    --description "Exemplo com texto, foto, recado de voz e vídeo, guardado no Arweave." --network "$NETWORK"
fi
cd "$DIR"
# Publish the samples only once per channel (on mainnet, repeats would be permanent).
count() { node -e "const c=require('./channel.json');console.log(c.posts.filter(p=>!p.removed&&(process.argv[1]==='video'?p.media&&p.media.videos:true)).length)" "$1"; }
if [[ "$(count all)" -eq 0 ]]; then
  "${AB[@]}" post "Olá! Este é um canal de demonstração do arboard. Cada post fica guardado no Arweave — não precisa de servidor ligado."
  "${AB[@]}" post "Uma foto de exemplo (3000×2000). Ao publicar, ela é reduzida e os metadados (GPS, modelo do aparelho) são removidos." \
    -i "$HERE/foto-exemplo.jpg"
  "${AB[@]}" post "Um recado de voz de exemplo, comprimido até caber no envio grátis." -a "$HERE/recado-exemplo.wav"
else
  echo "Este canal já tem os posts de exemplo; não vou publicar de novo."
fi
echo
echo "Esperando 20 s e abrindo o canal como um visitante…"
sleep "${DEMO_WAIT:-20}"
"${AB[@]}" status --check || true
echo
"${AB[@]}" nostr || true

# ------------------------------------------------------------------ vídeo (pago na mainnet)
post_video() {
  if [[ "$WITH_VIDEO" == "1" && "$(count video)" -gt 0 ]]; then
    echo "O vídeo de exemplo já está no canal."
  elif [[ "$WITH_VIDEO" == "1" ]]; then
    "${AB[@]}" post "Um vídeo de exemplo, convertido para 720p e com início rápido no navegador." -v "$HERE/video-exemplo.mov" \
      || echo "O vídeo não foi publicado (na mainnet ele é pago: \`arboard funds\` / \`arboard topup <eth> --yes\`)."
  else
    echo "(vídeo pulado: na mainnet ele é pago — use --with-video para incluir)"
  fi
}

# ------------------------------------------------------------------ nome (ArNS)
name_step() {
  local name="$1"
  echo
  echo "=== Teste do nome legível (ArNS): $name"
  local info
  if ! info=$("${AB[@]}" name check "$name" --json 2>&1); then
    echo "$info"; echo "Pulando o teste do nome."; return 0
  fi
  local url price credit enough
  url=$(echo "$info" | json_get url); price=$(echo "$info" | json_get lease_winc)
  credit=$(echo "$info" | json_get credit_winc); enough=$(echo "$info" | json_get enough)
  echo "Endereço: $url"
  echo "Preço (1 ano): $price winc de crédito · seu crédito: ${credit:-?} winc"

  if [[ "$enough" != "true" ]]; then
    local funds addr eth need amount
    need=$(echo "$info" | json_get eth_needed)
    funds=$("${AB[@]}" funds --json 2>/dev/null || echo '{}')
    addr=$(echo "$funds" | json_get address); eth=$(echo "$funds" | json_get eth)
    amount="${TOPUP:-$need}"
    # On mainnet with --with-video, add room for the video upload (a few hundred KB).
    if [[ -z "$TOPUP" && -n "$need" && "$NETWORK" == "mainnet" && "$WITH_VIDEO" == "1" ]]; then
      amount=$(node -e "console.log((Number(process.argv[1]) + 0.0002).toPrecision(2))" "$need")
    fi
    echo
    echo "Falta crédito. Ele é comprado com $ETH_LABEL."
    [[ "$NETWORK" == "testnet" ]] && echo "Faucet sem cadastro: https://sepolia-faucet.pk910.de (o navegador \"minera\" o ETH por alguns minutos)."
    if [[ -n "$need" ]]; then
      if [[ "$amount" != "$need" ]]; then echo "Para este nome: cerca de $need ETH; com o vídeo, $amount ETH. Mais um pouco para o gás."
      else echo "Para este nome: cerca de $need ETH, mais um pouco para o gás."; fi
    fi
    echo "Mande para a carteira do canal:"
    echo "    $addr"
    echo "ETH na carteira agora: ${eth:-não consegui consultar}"

    # Wait for the ETH to arrive (interactive), or give up cleanly.
    if ! has_eth "$eth" "$amount"; then
      if [[ $INTERACTIVE -eq 1 ]]; then
        while ! has_eth "$eth" "$amount"; do
          read -r -p "Mande o ETH e pressione Enter para conferir de novo (ou digite 'pular'): " ans
          [[ "$ans" == "pular" ]] && { skip_name_msg "$name" "$amount"; return 0; }
          eth=$("${AB[@]}" funds --json 2>/dev/null | json_get eth || true)
          echo "ETH na carteira: ${eth:-não consegui consultar}"
        done
      else
        echo "A carteira ainda não tem ETH suficiente."
        skip_name_msg "$name" "$amount"; return 0
      fi
    fi
    # Always leave some ETH on the wallet to pay the transfer's gas.
    local max
    max=$(node -e "const m=Number(process.argv[1])-Number(process.argv[2]);console.log(m>0?m.toFixed(6).replace(/0+$/,''):'0')" "${eth:-0}" "$GAS_RESERVE")
    if [[ -n "$amount" ]] && node -e "process.exit(Number(process.argv[1])>Number(process.argv[2])?0:1)" "$amount" "$max"; then
      echo "Deixando ~$GAS_RESERVE ETH para o gás: vou sugerir converter $max."
      amount="$max"
    fi
    if [[ $INTERACTIVE -eq 1 && -z "$TOPUP" ]]; then
      while true; do
        read -r -p "Quanto converter em crédito? (máx. $max) [${amount:-$max}]: " ans
        ans="${ans:-${amount:-$max}}"
        if node -e "const a=Number(process.argv[1]);process.exit(a>0&&a<=Number(process.argv[2])?0:1)" "$ans" "$max"; then amount="$ans"; break; fi
        echo "Use um valor entre 0 e $max (o resto paga o gás)."
      done
    fi
    if [[ "$NETWORK" == "mainnet" && $INTERACTIVE -eq 1 ]]; then
      read -r -p "Converter $amount ETH DE VERDADE em crédito? [s/N] " ans
      [[ "$ans" =~ ^[sSyY] ]] || { skip_name_msg "$name" "$amount"; return 0; }
    fi
    "${AB[@]}" topup "${amount:-0.01}" $(topup_flags) || { skip_name_msg "$name" "${amount:-0.01}"; return 0; }

    # The credit shows up after the transaction confirms — wait for it.
    echo "Esperando o crédito aparecer (até 5 min)…"
    for _ in $(seq 1 15); do
      info=$("${AB[@]}" name check "$name" --json 2>/dev/null) || true
      enough=$(echo "${info:-{\}}" | json_get enough 2>/dev/null || true)
      [[ "$enough" == "true" ]] && break
      sleep "${CREDIT_POLL:-20}"
    done
    if [[ "$enough" != "true" ]]; then
      echo "O crédito ainda não chegou (ou não basta). Confira com \`arboard funds\` e depois rode:"
      echo "  node \"$ROOT/arboard.mjs\" name buy $name --yes"
      return 0
    fi
  fi

  if [[ $INTERACTIVE -eq 1 ]]; then
    local what="com o crédito de teste"
    [[ "$NETWORK" == "mainnet" ]] && what="(pago com crédito comprado com ETH de verdade)"
    read -r -p "Comprar o nome $name $what? [s/N] " ans
    [[ "$ans" =~ ^[sSyY] ]] || { echo "Pulando a compra."; return 0; }
  fi
  "${AB[@]}" name buy "$name" --yes || { echo "A compra não terminou. Rode: node \"$ROOT/arboard.mjs\" name resume"; return 0; }
  echo
  echo "Esperando 20 s para o nome começar a responder…"
  sleep "${DEMO_WAIT:-20}"
  "${AB[@]}" name || true
}

if [[ $NO_NAME -eq 0 ]]; then
  if [[ -z "$NAME" && $INTERACTIVE -eq 1 ]]; then
    echo
    cost="Precisa de $ETH_LABEL."
    read -r -p "Quer testar também um nome legível (https://<nome>.$NAME_HOST)? $cost [s/N] " ans
    if [[ "$ans" =~ ^[sSyY] ]]; then
      suggestion="canal-demo-$(node -e "console.log(require('crypto').randomBytes(3).toString('hex'))")"
      read -r -p "Nome (mín. 8 caracteres) [$suggestion]: " NAME
      NAME="${NAME:-$suggestion}"
    fi
  fi
  [[ -n "$NAME" ]] && name_step "$NAME"
fi

# The video goes last: on mainnet it's paid, and the name step may have just added credit.
post_video

echo
echo "Abra o link da board no celular (em outra rede), siga o npub num app Nostr,"
echo "ou mande os dois para alguém testar."
[[ "$NETWORK" == "mainnet" ]] && echo "Lembrete: este canal é permanente. Guarde as chaves em $DIR (wallet.json, nostr-key.json)."
exit 0
