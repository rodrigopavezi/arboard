#!/usr/bin/env bash
# Cria um canal de verdade, passo a passo:
#   1. pergunta o nome do canal, a descrição e a rede;
#   2. cria a carteira e a chave Nostr do canal e publica a página;
#   3. publica a primeira mensagem ("Canal iniciado");
#   4. mostra a carteira do canal e pede os fundos ali mesmo (para vídeos e para o
#      nome legível), espera o ETH chegar e converte em crédito;
#   5. compra o nome legível (opcional) e confere o canal como um visitante.
#
# Pode rodar de novo na mesma pasta: ele continua de onde parou.
#
#   ./setup-channel.sh                       tudo perguntado (padrão: mainnet, permanente)
#   ./setup-channel.sh --testnet             canal de teste (grátis, apagado em ~3 dias)
#   ./setup-channel.sh --title "Avisos" --dir ./avisos --name avisos-do-bairro
#   ./setup-channel.sh --no-name             sem nome legível
#   ./setup-channel.sh --yes --title "X"     sem perguntas: só o que é grátis (sem fundos/nome)
#
# Depois, para postar:  cd <pasta> && node <arboard>/arboard.mjs post "texto" [-i foto] [-v vídeo] [-a áudio]
# Ao postar algo pago (vídeo), o arboard confere o crédito e, se faltar, pede os fundos na hora.
#
# Precisa de: Node 18+, ffmpeg (para foto/vídeo/áudio) e `npm install` feito nesta pasta.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
AB=(node "$ROOT/arboard.mjs")
NETWORK=""; DIR=""; TITLE=""; DESC=""; NAME=""; NO_NAME=0; YES=0; MESSAGE=""
DEFAULT_MESSAGE="📢 Canal iniciado! A partir de agora as mensagens aparecem aqui — e também no Nostr, para quem seguir o canal."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --testnet) NETWORK="testnet"; shift ;;
    --mainnet) NETWORK="mainnet"; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --description) DESC="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --no-name) NO_NAME=1; shift ;;
    --message) MESSAGE="${2:-}"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 1 ;;
  esac
done
INTERACTIVE=0; [[ $YES -eq 0 && ( -t 0 || "${SETUP_INTERACTIVE:-}" == 1 ) ]] && INTERACTIVE=1

command -v node >/dev/null || { echo "falta o Node.js (18 ou mais novo)" >&2; exit 1; }
[[ -d "$ROOT/node_modules/@ardrive/turbo-sdk" ]] || { echo "rode antes: (cd \"$ROOT\" && npm install)" >&2; exit 1; }
command -v ffmpeg >/dev/null || echo "Aviso: sem ffmpeg, só dá para postar texto (foto, vídeo e áudio precisam dele)."

json_get() { node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=j[process.argv[1]];console.log(v===null||v===undefined?'':v)" "$1"; }
ask() {  # ask "pergunta" "padrão" -> resposta (ou o padrão)
  local a; read -r -p "$1${2:+ [$2]}: " a || true; echo "${a:-$2}"
}
yn() {   # yn "pergunta" s|n -> sucesso se sim
  local d="$2" a hint="[s/N]"; [[ "$d" == "s" ]] && hint="[S/n]"
  read -r -p "$1 $hint " a || true; a="${a:-$d}"; [[ "$a" =~ ^[sSyY] ]]
}
slug() { node -e "console.log(process.argv[1].normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'canal')" "$1"; }
step() { echo; echo "=== $*"; }

# ------------------------------------------------------------------ 1. o canal
if [[ -n "$DIR" && -f "$DIR/channel.json" ]]; then
  RESUME=1
else
  RESUME=0
  if [[ -z "$TITLE" ]]; then
    [[ $INTERACTIVE -eq 1 ]] || { echo "sem terminal: passe --title \"Nome do canal\"" >&2; exit 1; }
    echo "Vamos criar o seu canal."
    while [[ -z "$TITLE" ]]; do TITLE="$(ask "Nome do canal (aparece no topo da página)" "")"; done
    DESC="$(ask "Descrição curta (opcional)" "$DESC")"
  fi
  [[ -z "$DIR" ]] && DIR="$PWD/$(slug "$TITLE")"
  if [[ -f "$DIR/channel.json" ]]; then RESUME=1; fi
fi

if [[ $RESUME -eq 1 ]]; then
  NETWORK="$(node -e "console.log(require(process.argv[1]).network)" "$DIR/channel.json")"
  echo "Continuando o canal em $DIR ($NETWORK)."
else
  if [[ -z "$NETWORK" ]]; then
    if [[ $INTERACTIVE -eq 1 ]]; then
      echo
      echo "Rede:"
      echo "  1) mainnet — canal de verdade, PERMANENTE (texto, fotos e áudio grátis; vídeo e nome pagos com ETH)"
      echo "  2) testnet — só para testar: grátis, apagado em ~3 dias"
      case "$(ask "Escolha" "1")" in 2|testnet) NETWORK="testnet" ;; *) NETWORK="mainnet" ;; esac
    else
      NETWORK="mainnet"
    fi
  fi

  echo
  if [[ "$NETWORK" == "mainnet" ]]; then
    cat <<EOF
ATENÇÃO — o canal vai para a MAINNET do Arweave:
  • é PERMANENTE: nada publicado pode ser apagado (o "remover" só esconde da página);
  • é público: qualquer pessoa com o link vê;
  • uma carteira e uma chave Nostr novas são criadas só para este canal;
  • o serviço de envio e os relays veem o IP desta conexão (use VPN se importar).
Título:    $TITLE
Descrição: ${DESC:-(nenhuma)}
Pasta:     $DIR
EOF
    if [[ $INTERACTIVE -eq 1 ]]; then
      [[ "$(ask "Para criar, digite 'permanente'" "")" == "permanente" ]] || { echo "Cancelado."; exit 0; }
    elif [[ $YES -ne 1 ]]; then
      echo "Sem terminal para confirmar: rode com --yes." >&2; exit 1
    fi
  else
    echo "Canal de teste na testnet (grátis, apagado em ~3 dias) em $DIR"
  fi

  step "Criando o canal"
  "${AB[@]}" init "$DIR" --title "$TITLE" --description "$DESC" --network "$NETWORK"
fi
cd "$DIR"

# ------------------------------------------------------------------ 2. primeira mensagem
POSTS="$(node -e "console.log(require('./channel.json').posts.filter(p=>!p.removed).length)")"
if [[ "$POSTS" -eq 0 ]]; then
  step "Primeira mensagem"
  if [[ -z "$MESSAGE" ]]; then
    MESSAGE="$DEFAULT_MESSAGE"
    if [[ $INTERACTIVE -eq 1 ]]; then
      echo "Sugestão: $DEFAULT_MESSAGE"
      MESSAGE="$(ask "Primeira mensagem (Enter usa a sugestão)" "")"
      MESSAGE="${MESSAGE:-$DEFAULT_MESSAGE}"
    fi
  fi
  "${AB[@]}" post "$MESSAGE" --no-balance
else
  echo "O canal já tem $POSTS post(s); pulando a primeira mensagem."
fi

# ------------------------------------------------------------------ 3. fundos e nome
FUNDS="$("${AB[@]}" funds --json 2>/dev/null || echo '{}')"
ADDR="$(echo "$FUNDS" | json_get address)"; CHAIN="$(echo "$FUNDS" | json_get chain)"
CREDIT="$(echo "$FUNDS" | json_get credit_winc)"; PER_MB="$(echo "$FUNDS" | json_get winc_per_mb)"
HAS_NAME="$(echo "$FUNDS" | json_get has_name)"

step "Carteira e fundos"
cat <<EOF
Carteira do canal ($CHAIN ETH):

    $ADDR

Texto, fotos e recados de voz são grátis. Fundos servem para:
  • vídeos (cada um passa do tamanho grátis);
  • o nome legível (https://<nome>.turbo-gateway.com), que evita alertas de antivírus.
EOF
[[ "$NETWORK" == "testnet" ]] && echo "Na testnet o ETH é de teste (Sepolia): https://sepolia-faucet.pk910.de"
echo "Crédito atual: ${CREDIT:-?} winc"

NAME_WINC=0
if [[ "$HAS_NAME" == "true" ]]; then
  echo "O canal já tem um nome legível."
  NO_NAME=1
elif [[ $NO_NAME -eq 0 && -z "$NAME" && $INTERACTIVE -eq 1 ]]; then
  echo
  if yn "Quer um nome legível para o link? (recomendado)" s; then
    MIN=1; [[ "$NETWORK" == "testnet" ]] && MIN=8
    while :; do
      NAME="$(ask "Nome (letras minúsculas, números e '-'; mín. $MIN caracteres)" "$(slug "$(node -e "console.log(require('./channel.json').title)")")")"
      if INFO="$("${AB[@]}" name check "$NAME" --json 2>&1)"; then break; fi
      echo "$INFO" | sed 's/^error: /  /'
      yn "Tentar outro nome?" s || { NAME=""; INFO=""; break; }
    done
  fi
fi
if [[ -n "$NAME" && $NO_NAME -eq 0 ]]; then
  if [[ -z "${INFO:-}" ]] && ! INFO="$("${AB[@]}" name check "$NAME" --json 2>&1)"; then echo "$INFO"; NAME=""; fi
  if [[ -n "$NAME" ]]; then
    NAME_WINC="$(echo "$INFO" | json_get lease_winc)"
    echo "Nome: $(echo "$INFO" | json_get url)  — 1 ano: $NAME_WINC winc"
  fi
fi

VIDEO_MB=0
if [[ $INTERACTIVE -eq 1 && -n "$PER_MB" ]]; then
  echo
  echo "Cada MB de vídeo custa ~$PER_MB winc (um vídeo de celular de 1 min fica com ~5–10 MB depois de convertido)."
  VIDEO_MB="$(ask "Quantos MB de vídeo quer deixar pagos desde já? (0 = nenhum; dá para pôr depois)" "0")"
  [[ "$VIDEO_MB" =~ ^[0-9]+$ ]] || VIDEO_MB=0
fi

NEED="$(node -e "const [n,mb,per,c]=process.argv.slice(1).map(x=>BigInt(x||'0'));const d=n+mb*per-c;console.log(d>0n?String(d):'0')" \
  "$NAME_WINC" "$VIDEO_MB" "${PER_MB:-0}" "${CREDIT:-0}")"
WHY=""
[[ -n "$NAME" && "$NAME_WINC" != "0" ]] && WHY="the name $NAME"
[[ "$VIDEO_MB" -gt 0 ]] && WHY="${WHY:+$WHY and }$VIDEO_MB MB of video"

if [[ $INTERACTIVE -eq 1 ]]; then
  if [[ "$NEED" != "0" ]]; then
    "${AB[@]}" topup --need "$NEED" --for "$WHY" || echo "Sem fundos por enquanto. Dá para adicionar depois com: node \"$ROOT/arboard.mjs\" topup"
  elif [[ -z "$NAME" && "$VIDEO_MB" -eq 0 ]]; then
    if yn "Quer adicionar fundos agora mesmo assim?" n; then
      "${AB[@]}" topup || true
    fi
  else
    echo "O crédito atual já cobre isso."
  fi
  if [[ -n "$NAME" ]]; then
    step "Nome legível: $NAME"
    if yn "Comprar $NAME por 1 ano com o crédito?" s; then
      "${AB[@]}" name buy "$NAME" --yes || echo "A compra não terminou. Rode depois: node \"$ROOT/arboard.mjs\" name resume (ou name buy $NAME --yes)"
    fi
  fi
elif [[ -n "$NAME" ]]; then
  echo "Sem terminal: para comprar o nome depois, mande ETH para $ADDR e rode, dentro de $DIR:"
  echo "  node \"$ROOT/arboard.mjs\" topup   (guiado)    e    node \"$ROOT/arboard.mjs\" name buy $NAME --yes"
fi

# ------------------------------------------------------------------ 4. conferir
step "Conferindo o canal como um visitante "
sleep "${SETUP_WAIT:-20}"
"${AB[@]}" status --check || true

NPUB="$(node -e "const c=require('./channel.json');console.log(c.nostr?c.nostr.npub:'')")"
cat <<EOF

Pronto.
  Pasta do canal: $DIR
  Nostr:          ${NPUB:-—}
  Chaves:         wallet.json, nostr-key.json$( [[ -f arns-owner.json ]] && echo ", arns-owner.json") — faça BACKUP; quem tem
                  essas chaves posta pelo canal. Nunca compartilhe.

Para postar (dentro de $DIR):
  node "$ROOT/arboard.mjs" post "Texto"
  node "$ROOT/arboard.mjs" post "Foto do dia" -i foto.jpg
  node "$ROOT/arboard.mjs" post "Recado" -a audio.m4a
  node "$ROOT/arboard.mjs" post "Vídeo" -v video.mp4     (pago: confere o crédito e pede fundos se faltar)
Saldo e carteira:  node "$ROOT/arboard.mjs" funds     ·   adicionar fundos:  node "$ROOT/arboard.mjs" topup
EOF
exit 0
