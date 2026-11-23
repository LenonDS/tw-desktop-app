# TW Evolution — Gerenciador Multi-Sessão para Tribal Wars

Aplicação desktop open source para gerenciamento de múltiplas contas, proxies dedicados, agendamento de comandos com precisão de milissegundos, planejamento coordenado de operações, evasão automática, encaixe de snips e assistente de saque no **Tribal Wars**.

Construído com **Electron**, **React 19**, **TypeScript**, **Tailwind CSS v4** e **Vite**.

---

## Funcionalidades Principais

- **Multi-Sessões Isoladas & Proxies:**
  - Sessões e cookies isolados por conta (`persist:tw-<id>`), com suporte a múltiplas janelas independentes por conta e atalhos diretos para telas do jogo.
  - Suporte completo a proxies `HTTP`, `HTTPS`, `SOCKS4` e `SOCKS5` dedicados por perfil, com testador integrado de conectividade e latência.
- **Agendador & Planejador de Operações (OP):**
  - Disparo por **horário de chegada** ou **horário de envio**, com cálculo automático usando velocidade do mundo e das unidades obtidas do servidor oficial (`/interface.php?func=get_config` e `get_unit_info`).
  - Preparação em duas etapas na Praça de Reunião e suporte a múltiplas ondas (Noble Trains e ataques em massa).
  - **Planejador OP (Multi-Origem → Multi-Destino):** leitura da Visão Combinada, busca de jogadores-alvo, filtros por tropas/grupos e envio concorrente multi-janela.
  - Proteção anti-throttling (`powerSaveBlocker`, `backgroundThrottling: false`) para disparos pontuais em segundo plano.
- **Etiquetador de Ataques, Auto-Dodge & Auto-Snip:**
  - Classificação automática da unidade mais lenta de ataques recebidos pela velocidade.
  - **Auto-Dodge:** retirada automática das tropas antes do impacto (apoio + cancelamento programado).
  - **Auto-Snip:** detecção de janelas em milissegundos entre ataques inimigos e seleção de apoios viáveis para encaixe.
- **Auto-Farm (Assistente de Saque & Rotas):**
  - Configurações independentes por aldeia, prioridade de modelos (A/B + C de acompanhamento), detecção de alvos duplicados entre origens, rotas personalizadas para jogadores e parada automática de segurança (CAPTCHA, ataque iminente, estoque mínimo ou limite diário).
- **Aldeias, Modelos & Diagnóstico:**
  - Diretório sincronizado de aldeias, recursos, população e tropas em casa.
  - Templates de construção e recrutamento vinculados por conta.
  - Logs de sessão + registro rotacionado em arquivo (`app.log` em `userData/logs`) com redação automática de dados sensíveis e exportação pela interface.

---

## Segurança Local

- Senhas de conta, senhas de proxy e valores de cookies persistidos em `tw-store.json` são criptografados em repouso via API nativa `safeStorage` do Electron (DPAPI no Windows / Keychain no macOS).
- Janela principal executa com `contextIsolation: true`, `nodeIntegration: false` e `sandbox: true`, expondo apenas os canais estritamente necessários em `electron/preload.ts`.
- Logs em arquivo passam por redação automática de senhas, cookies, tokens e credenciais em URLs antes de serem gravados ou exportados.

---

## Requisitos de Sistema

- **Node.js**: 20.x ou superior (recomendado 22.x LTS)
- **npm**: 10.x ou superior
- **Sistema Operacional**: Windows 10/11, Linux ou macOS

---

## Instalação e Execução

```bash
git clone https://github.com/LenonDS/tw-desktop-app.git
cd tw-desktop-app
npm install
```

### Modo Desktop (Electron)
```bash
npm start
```

### Desenvolvimento do Renderer (Vite HMR)
```bash
npm run dev:renderer
```

### Build & Testes
```bash
npm run build
npm test
```

---

## Estrutura do Projeto

```text
tw-desktop-app/
├── electron/                 # Processo Main, IPC, SessionManager, serviços e segurança
│   ├── main.ts               # Entrypoint Electron, handlers IPC e janela principal
│   ├── preload.ts            # Bridge segura via contextBridge
│   ├── sessionManager.ts     # Sessões isoladas, automações e scraper do jogo
│   ├── schedulerService.ts   # Fila e timers de disparo de comandos
│   ├── autoFarmService.ts    # Rotinas de Auto-Farm e pausas de segurança
│   ├── store.ts              # Persistência JSON atômica + helpers de domínio
│   ├── secretCrypto.ts       # Criptografia de credenciais via safeStorage
│   └── fileLogger.ts         # Log rotacionado (app.log) com redação de segredos
├── src/                      # Interface React 19 + Tailwind CSS v4
│   ├── components/           # Telas, modais e primitivos em components/ui/
│   ├── utils/                # Motores client-side (plannerEngine, snipEngine)
│   ├── App.tsx               # Shell principal, navegação e estado global
│   ├── index.css             # Tokens @theme e regras base de acessibilidade
│   └── types.ts              # Contratos TypeScript e tipagem da bridge IPC
└── tests/                    # Suíte de testes automatizados (node --test)
```

---

## Aviso Legal & Termos de Uso

Este é um projeto open source independente, **sem qualquer afiliação, endosso ou vínculo com a InnoGames GmbH ou com o jogo Tribal Wars**.
O uso de ferramentas de automação pode violar os Termos e Condições / Regras do jogo em servidores oficiais. Utilize este software exclusivamente para fins educacionais ou em ambientes autorizados, **por sua conta e risco**.

---

## Contribuição & Licença

Contribuições são bem-vindas via Pull Request (direcionado à branch `main`). Antes de abrir um PR, execute `npm run build` e `npm test`.

Distribuído sob a licença **MIT**. Consulte [LICENSE](./LICENSE) para mais detalhes.
