# arboard

Um canal de mensagens (texto, fotos, vídeos e recados de voz) guardado no **Arweave** e
publicado também no **Nostr**. São duas formas independentes de acesso:

| | **Board no Arweave** | **Nostr** |
|---|---|---|
| O que fica lá | o post completo — texto, fotos, vídeos, áudios | uma nota com o texto e os links das mídias |
| Papel | fonte principal e **permanente** | **leitura em apps** e **avisos** de novos posts |
| Como se lê | a página do canal, em qualquer gateway | qualquer app Nostr (Damus, Nostur, Amethyst, Primal…) |
| Ninguém falsifica porque | só vale o que a carteira do canal assina | só vale o que a chave Nostr do canal assina |

Se os relays Nostr caírem ou forem bloqueados, a board no Arweave tem tudo. Se um gateway
do Arweave for bloqueado, quem segue no Nostr continua recebendo — e a board abre por
outro gateway.

- **Não precisa de servidor ligado.** Cada post é gravado na rede Arweave, que guarda e
  serve o conteúdo. Depois de postar, você pode desligar tudo.
- **O link do canal nunca muda.** A página é enviada uma vez e busca os posts direto da
  rede, a cada visita.
- **Só você posta.** A página só mostra itens assinados pela carteira do canal; posts de
  outras carteiras com o mesmo canal são ignorados.
- **Sem cadastro.** A "conta" é uma carteira (e uma chave Nostr) gerada no seu computador.

## Redes

| | `testnet` (padrão) | `mainnet` |
|---|---|---|
| Para quê | testar | canal de verdade |
| Dados | **temporários** (~3 dias) | **permanentes** — não dá para apagar nunca |
| Custo | grátis até o limite da testnet; acima disso, crédito com **Sepolia ETH** | itens até **105 KiB grátis**; acima disso, pago (ETH) |
| Link | `https://ar-io.dev/<id>` | `https://arweave.net/<id>` |

## Instalação

Precisa de **Node.js 18+** e **ffmpeg**.

```bash
cd arboard
npm install
```

## Criar o seu canal (passo a passo)

```bash
./setup-channel.sh              # mainnet (permanente) — ou --testnet para ensaiar
```
O script pergunta o nome e a descrição do canal e:
1. cria a carteira e a chave Nostr do canal (só dele) e publica a página;
2. publica a primeira mensagem — "📢 Canal iniciado! …" (ou a que você escrever);
3. **mostra a carteira do canal e pede os fundos ali mesmo**: pergunta se você quer o nome
   legível e quantos MB de vídeo quer deixar pagos, calcula quanto ETH mandar, espera o
   ETH chegar (Enter para conferir de novo), converte em crédito e compra o nome;
4. abre o canal como um visitante e mostra como postar.

Texto, fotos e recados de voz são grátis; fundos são só para vídeo e para o nome. Dá para
pular os fundos e adicionar depois com `arboard topup`. Se parar no meio, rode de novo com
`--dir <pasta-do-canal>` e ele continua de onde parou.
Opções: `--testnet`, `--title`, `--description`, `--dir`, `--name <nome>`, `--no-name`,
`--message "<primeira mensagem>"`, `--yes` (sem perguntas: só o que é grátis).

## Teste rápido com os exemplos

```bash
./samples/try-it.sh
```
Cria um canal na testnet com uma foto, um recado de voz e um vídeo de exemplo, publica
também no Nostr, e mostra o link da board e o `npub`. No fim, pergunta se você quer testar
um **nome legível** (`https://<nome>.ar-io.dev`):

- confere o preço e o seu crédito;
- se faltar crédito, mostra quanto **Sepolia ETH** o nome custa e o endereço da carteira do
  canal; espera o ETH chegar e converte em crédito. Faucet sem cadastro:
  [sepolia-faucet.pk910.de](https://sepolia-faucet.pk910.de) (o navegador "minera" o ETH);
- compra o nome e confere se ele aponta para a board.

Sem perguntas:
```bash
./samples/try-it.sh --yes                                   # pula o nome
./samples/try-it.sh --name canal-demo-123 --topup 0.01      # testa o nome (mande o ETH antes)
```
Abra o link no celular (em outra rede), siga o `npub` num app Nostr, e mande para alguém
testar. Nada disso usa dinheiro de verdade.

### Canal de teste na mainnet (permanente)
```bash
./samples/try-it.sh --mainnet                 # pede para digitar "permanente"
./samples/try-it.sh --mainnet --yes           # sem perguntas
./samples/try-it.sh --mainnet --with-video    # inclui o vídeo (pago)
./samples/try-it.sh --mainnet --with-video --name meu-canal-teste   # tudo: posts, nome e vídeo
```
Com `--name`, o script publica os posts grátis, mostra quanto ETH mandar para a carteira do
canal (nome + vídeo), espera o ETH chegar, converte em crédito, compra o nome e só então
publica o vídeo.
- **Grátis por padrão:** texto, foto e recado de voz cabem no limite grátis de 105 KiB por
  arquivo. O vídeo (~400 KB) e o nome legível são pagos com **ETH de verdade** e só entram
  se você pedir (`--with-video`, ou responder sim ao teste do nome).
- **Permanente:** nada pode ser apagado depois. O conteúdo é só o de exemplo, e a carteira e
  a chave Nostr são novas, só para este teste.
- Rodar de novo não republica os exemplos; só acrescenta o vídeo se você pedir e ele ainda
  não estiver lá.
- O nome fica em `https://<nome>.turbo-gateway.com` (o `arweave.net` não resolve nomes ArNS).

## Uso

```bash
node arboard.mjs init meucanal --title "Notícias" --description "Recados para a família"
cd meucanal
# FAÇA BACKUP de wallet.json e nostr-key.json — são as únicas chaves que postam neste canal
# (e de arns-owner.json, se você comprar um nome)

node ../arboard.mjs post "Olá a todos!"
node ../arboard.mjs post "Fotos" -i a.jpg -i b.jpg
node ../arboard.mjs post "Recado" -a recado.m4a
node ../arboard.mjs post "Vídeo" -v video.mov

node ../arboard.mjs status --check      # link, carteira, crédito; abre como um visitante
node ../arboard.mjs list
node ../arboard.mjs remove <id-do-post>  # esconde o post (o original continua no Arweave)
node ../arboard.mjs title "Novo título" --description "..."
node ../arboard.mjs funds               # ETH na carteira do canal e crédito de envio
node ../arboard.mjs topup               # guiado: mostra a carteira, espera o ETH e converte
node ../arboard.mjs topup 0.01          # converte essa quantia direto (na mainnet, com --yes)
node ../arboard.mjs links               # links alternativos em outros gateways
node ../arboard.mjs nostr               # npub, links e quais relays têm o canal
node ../arboard.mjs name check <nome>   # endereço legível: https://<nome>.turbo-gateway.com
```
Dica: `npm link` dentro da pasta do arboard instala o comando `arboard`.

Para um canal permanente: `init ... --network mainnet`. Para usar a mesma carteira em
vários canais: `init ... --wallet caminho/wallet.json`.

### O que acontece com a mídia
Antes de enviar, o arboard converte e **remove os metadados** (localização GPS, modelo do
aparelho, datas, nome do programa). Fotos e recados de voz são comprimidos até caberem no
envio grátis quando possível:
```
image: foto-exemplo.jpg (227 KB → 32 KB, free)
audio: recado-exemplo.wav (1.4 MB → 105 KB, free)
video: video-exemplo.mov (2.2 MB → 447 KB, paid)
```

### Saldo ao postar
Quando um post tem algo pago (vídeo), o arboard **confere o crédito antes de enviar**. Se
faltar, mostra quanto custa, a carteira do canal e quanto ETH mandar, espera o ETH chegar e
converte — tudo no mesmo comando; nada é enviado pela metade. Sem terminal (num script),
ele para com essas instruções. Depois de cada post aparece o saldo:
```
Credit:    0.375514 AR in credits (…) — about 60 MB of video. Text, photos and voice notes are free.
```
(`--no-balance` esconde essa linha.)

### Pagando com Sepolia (testnet)
1. `node ../arboard.mjs status` mostra o endereço da carteira do canal (`0x…`).
2. Mande Sepolia ETH para esse endereço (de uma faucet).
3. `node ../arboard.mjs topup` (guiado) ou `topup 0.005` converte em crédito de envio.

Na mainnet é igual, com ETH de verdade (o comando pede `--yes`).

## Como funciona

Cada post é um item no Arweave com as tags `App-Name: arboard`, `Channel: <id>` e
`Type: post`, assinado pela carteira do canal. As mídias são itens separados. A página
do canal consulta o GraphQL do gateway pedindo só itens **daquela carteira** com aquele
`Channel`, e monta a lista. Título/descrição (`Type: profile`) e remoções
(`Type: delete`) seguem o mesmo esquema.

Configuração em `channel.json` (pode compartilhar) e chaves em `wallet.json`,
`nostr-key.json` e `arns-owner.json` (**nunca** compartilhe). Variáveis para outros serviços:
`ARBOARD_UPLOAD_URL`, `ARBOARD_PAYMENT_URL`, `ARBOARD_GATEWAY`, `ARBOARD_NAME_GATEWAY`, `ARBOARD_RPC`,
`ARBOARD_RELAYS` (lista separada por vírgula).

## Nostr: leitura em apps e avisos de novos posts

No `init`, o arboard cria uma **chave Nostr para o canal** (`nostr-key.json`) e publica o
perfil (nome, descrição e o link da board) em 7 relays públicos independentes. A cada
`post`, publica uma nota **assinada** com o texto, os links das mídias (com gateways
alternativos para cada uma, no padrão NIP-92) e o link do post na board.

A board mostra a caixa **"Siga no Nostr"**: um botão que abre o canal no app Nostr
instalado (`nostr:npub…`), os apps sugeridos para cada aparelho e o **endereço oficial**
(`npub`) com botão de copiar. Quem segue recebe os posts no app; os avisos de post novo
dependem do app (no **Nostur**, do iPhone, há uma opção de notificação no perfil).

```bash
node ../arboard.mjs nostr                       # npub, links e o que cada relay tem
node ../arboard.mjs post "..." --no-nostr       # posta só no Arweave
node ../arboard.mjs nostr publish <id-do-post>  # publica depois no Nostr
node ../arboard.mjs nostr relays add wss://relay.exemplo.com
node ../arboard.mjs nostr resend                # reenvia as mesmas notas assinadas (ex.: relay novo)
node ../arboard.mjs init x --no-nostr           # canal sem Nostr
```

- **Ninguém se passa pelo canal:** relays e apps conferem a assinatura de cada nota.
  Alguém pode criar um perfil com o mesmo nome, mas não com o mesmo `npub` — por isso a
  board mostra o endereço oficial.
- **Relays caem ou apagam?** Cada nota vai para vários; `nostr resend` copia tudo de novo.
  O `channel.json` guarda as notas assinadas, então reenviar não muda nada nelas.
- `remove` também manda um pedido de remoção (NIP-09). Relays e apps que respeitam
  escondem a nota; cópias já salvas por outros podem continuar existindo.
- Na **testnet**, as mídias somem do Arweave em ~3 dias, mas as notas Nostr ficam nos
  relays reais — com links quebrados. Use uma chave de teste e não divulgue.

## Endereço legível (ArNS) — evita alarme falso de antivírus

Links como `arweave.net/<43 caracteres>` (que redirecionam para um subdomínio aleatório)
parecem páginas de phishing descartáveis, e antivírus como o Kaspersky às vezes bloqueiam.
Um **nome ArNS** dá ao canal um endereço fixo e legível — `https://<nome>.turbo-gateway.com` —
que pode ganhar reputação e ser liberado uma vez só, se algum antivírus reclamar.

```bash
node ../arboard.mjs name check noticias-da-familia     # preço e se está livre
node ../arboard.mjs topup 0.01                         # crédito, se precisar
node ../arboard.mjs name buy noticias-da-familia --yes # aluguel de 1 ano (--years 1-5 ou --permanent)
node ../arboard.mjs name                               # status: aponta para a página atual?
node ../arboard.mjs name extend --years 1 --yes         # renova o aluguel
```

- **Pago com o crédito de envio** (o mesmo do `topup`; na testnet, Sepolia ETH). Não
  precisa de outro token nem de cadastro.
- **Dono do nome:** uma chave Solana criada na pasta do canal (`arns-owner.json`) — **faça
  backup**. Ela só assina; as taxas da rede Solana são pagas pelo serviço.
- O nome já nasce apontando para a board. Depois de comprar, a CLI atualiza o perfil do
  canal (a board passa a mostrar links alternativos com o nome) e o perfil Nostr, e as
  notas novas passam a usar o nome. `republish-page` reaponta o nome sozinho.
- **Qualquer gateway AR.IO resolve o mesmo nome:** `nome.turbo-gateway.com`,
  `nome.ardrive.net`, `nome.ar-io.net`, … — `arboard links` lista os que funcionam.
  O `arweave.net` é exceção: guarda e busca os posts, mas responde 404 para nomes.
  Por isso a board, aberta pelo nome, busca os posts no `arweave.net` quando o gateway
  do nome não os encontra.
- Se a compra for interrompida, `arboard name resume` termina sem cobrar de novo.
- Na **testnet**, nomes precisam de pelo menos 8 caracteres e ficam em `<nome>.ar-io.dev`.
- Se um antivírus ainda reclamar do nome: peça reanálise em
  [opentip.kaspersky.com](https://opentip.kaspersky.com) (e confira no VirusTotal).

## Se um endereço for bloqueado

O conteúdo não pertence a um site: o mesmo ID abre em **qualquer gateway** da rede
AR.IO. Um provedor pode bloquear um domínio (por DNS, IP ou SNI), mas não o canal.

- `arboard links` testa gateways da rede e lista os que servem o seu canal — divulgue
  alguns junto com o link principal.
- A página descobre gateways sozinha: se o gateway onde foi aberta falhar na busca ou
  nas mídias, ela tenta outros (os gravados nela na criação e os que o próprio gateway
  conhece) e mostra no rodapé onde mais o canal abre.
- Quem lê com HTTPS: o provedor vê qual gateway foi acessado, mas não qual canal.
- Na **testnet** só existe um gateway (`ar-io.dev`), então não há alternativas.
- Gateways podem se recusar a servir um ID específico (moderação); os outros continuam.

## Privacidade — leia antes de usar de verdade

- **Tudo é público** e, na mainnet, **permanente**. "Remover" só esconde da página.
- **Todos os posts ficam ligados ao endereço da carteira.** Ele não tem seu nome, mas é
  o mesmo em todos os posts. Use uma carteira só para isso.
- **O serviço de envio e os relays Nostr veem o seu IP** a cada post. Use VPN se isso importar.
- **O nome ArNS também é público** e fica ligado ao canal e à chave dona dele. Escolha um
  nome que não identifique você, e lembre que comprar com ETH de corretora com cadastro
  deixa rastro.
- **Carteira e `npub` ficam ligados publicamente** (a board mostra o `npub`, e o perfil
  Nostr aponta para a board). É assim que um confirma o outro — não reutilize nenhum dos
  dois em outro lugar.
- **Pagamentos deixam rastro.** ETH que veio de uma corretora com cadastro liga a
  carteira a você. Itens até 105 KiB não precisam de pagamento nenhum.
- **Gateways podem se recusar a exibir conteúdo**, mas há vários gateways independentes,
  e qualquer um que siga o padrão AR.IO abre o mesmo link.

## Testar sem rede

`test/mock_arweave.mjs` simula o serviço de envio e um gateway, e `test/mock_relay.mjs`
simula relays Nostr — os dois conferem as assinaturas como os serviços reais:
```bash
node test/mock_arweave.mjs 9400 &          # ou 9400,9401,9402 com MOCK_BROKEN / MOCK_BLOCKED / MOCK_UNINDEXED
node test/mock_relay.mjs 7001,7002 &       # MOCK_RELAY_REJECT=7002 faz um recusar tudo
export ARBOARD_UPLOAD_URL=http://127.0.0.1:9400 ARBOARD_PAYMENT_URL=http://127.0.0.1:9400 ARBOARD_GATEWAY=http://127.0.0.1:9400
export ARBOARD_RELAYS=ws://127.0.0.1:7001,ws://127.0.0.1:7002
node arboard.mjs init teste && cd teste && node ../arboard.mjs post "oi"
```
