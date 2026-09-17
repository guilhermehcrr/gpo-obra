# GPO Obra

Sistema web de engenharia e gestão de obra para projetos de rede de distribuição
de energia elétrica. Substitui a planilha de cálculo por cadastros próprios,
tabelas normativas versionadas, folha de dados com validação em tela e controle
de acesso por perfil.

---

## Rodar na sua máquina

Precisa apenas do Node 18 ou mais novo. Não há dependências para instalar.

```bash
cp .env.example .env      # opcional: o padrão já funciona
npm run seed              # carrega os cadastros de data/ no banco
npm start                 # sobe em http://localhost:3000
```

Abra `http://localhost:3000`. Na primeira vez o sistema pede para criar o
administrador. Não existe senha padrão.

Para recomeçar do zero, apague a pasta `banco/` e rode `npm run seed` de novo.

---

## Banco de dados

O arquivo `.env` decide onde os dados ficam.

### `GPO_DB=local` (padrão)

No Node 22.5 ou mais novo usa o SQLite embutido (`banco/gpo.db`). Em versões
anteriores cai para um arquivo JSON (`banco/gpo.json`), com o mesmo
comportamento. Serve para desenvolver e testar sem depender de rede.

### `GPO_DB=supabase`

Usa o PostgreSQL do Supabase pela API REST, sem biblioteca externa.

1. Crie o projeto em <https://supabase.com>.
2. Abra **SQL Editor**, cole o conteúdo de `supabase/schema.sql` e execute.
3. Em **Project Settings → Data API**, copie a **Project URL**.
4. Em **Project Settings → API Keys**, copie a chave **service_role**.
5. Preencha o `.env`:

```env
GPO_DB=supabase
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
```

6. Rode `npm run seed` para levar os cadastros para o Supabase e `npm start`.

A chave `service_role` ignora as regras de acesso do banco, então ela fica
**apenas no servidor**, nunca no navegador. O `schema.sql` deixa as tabelas com
RLS ligado e sem policy, de modo que as chaves públicas não alcançam nada: todo
acesso passa pela API deste projeto, que aplica os perfis de usuário.

---

## Subir no servidor

O sistema é um processo Node ouvindo numa porta. Qualquer VPS com Node 18+
serve.

```bash
# no servidor
git clone <repositório> /opt/gpo-obra     # ou envie os arquivos por scp/rsync
cd /opt/gpo-obra
cp .env.example .env && nano .env         # GPO_DB=supabase e as credenciais
npm run seed
```

Serviço com systemd, em `/etc/systemd/system/gpo-obra.service`:

```ini
[Unit]
Description=GPO Obra
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gpo-obra
ExecStart=/usr/bin/node server/index.js
Environment=PORT=3000
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now gpo-obra
```

Nginx na frente, com HTTPS pelo certbot:

```nginx
server {
  server_name gpo.seudominio.com.br;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
certbot --nginx -d gpo.seudominio.com.br
```

---

## Organização dos arquivos

```
gpo-obra/
  server/
    index.js      servidor HTTP, API e entrega da interface
    store.js      camada de dados (local ou Supabase)
    seed.js       carga inicial dos cadastros
  public/
    index.html
    assets/app.css
    assets/app.js interface, validação e regras da folha de dados
  data/           cadastros e tabelas normativas em JSON
  supabase/
    schema.sql    estrutura das tabelas
  banco/          criado em tempo de execução no modo local
```

---

## API

Todas as rotas respondem JSON. Fora de `login` e `primeiro-acesso`, é preciso
enviar `Authorization: Bearer <token>`.

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/api/estado` | Cadastros, obras, usuários e a sessão atual |
| `POST` | `/api/primeiro-acesso` | Cria o administrador (só quando não há usuário) |
| `POST` | `/api/login` | Abre sessão |
| `POST` | `/api/sair` | Encerra a sessão |
| `PUT` | `/api/catalogo/:chave` | Grava um cadastro ou tabela normativa |
| `PUT` | `/api/obras/:id` | Cria ou atualiza uma obra |
| `DELETE` | `/api/obras/:id` | Exclui uma obra |
| `PUT` | `/api/usuarios/:id` | Cria ou atualiza um usuário |
| `DELETE` | `/api/usuarios/:id` | Exclui um usuário |
| `GET` | `/api/registro` | Últimas 200 operações |
| `POST` | `/api/registro` | Registra uma operação |

---

## Perfis de acesso

| Perfil | Cadastros | Tabelas normativas | Obras | Usuários | Registro |
|---|---|---|---|---|---|
| Administrador | edita | edita | edita | edita | consulta |
| Engenharia | edita | edita | consulta | — | consulta |
| Projetista | consulta | consulta | edita | — | — |
| Consulta | consulta | consulta | consulta | — | — |

As senhas são guardadas com `scrypt` e sal por usuário. As sessões ficam em
memória e valem 12 horas, o que significa que reiniciar o serviço desconecta
todo mundo. Para vários processos em paralelo, guardar as sessões no banco.

---

## Cadastros incluídos

| Cadastro | Registros |
|---|---|
| Municípios com constantes A e B, tensões e concessionária | 581 |
| Materiais com classe, unidade, fabricante, fornecedor e GED | 266 |
| Especificações técnicas | 387 |
| Normas técnicas | 57 |
| Padrões de instalação | 57 |
| GED 3738 — consumo por atividade e tipo de ligação | 65 × 18 |
| Concessionárias | 8 |
| Fabricantes | 34 |
| Fornecedores | 17 |
| Diâmetro de poste e cintas | 15 bitolas |
| Dados técnicos de cabos, GED aplicável, serviços, unidades | 86 |

Os preços de materiais e serviços entram em branco, aguardando a tabela vigente.

### Diâmetro de poste e cintas

A tabela de origem trazia 3.999 linhas. A relação é linear, então o sistema
guarda apenas os parâmetros de cada bitola e calcula o resto:

```
diâmetro no ponto = Ø topo + distância do topo × conicidade
conicidade        = (Ø base − Ø topo) / (altura × 1000)
```

A fórmula foi conferida contra as 3.999 linhas e reproduz todas.

---

## Próximos módulos

Cálculo de demanda, vãos entre pontos, queda de tensão, esforço mecânico,
lista de materiais, custos e impostos, TAGs e documentos.
