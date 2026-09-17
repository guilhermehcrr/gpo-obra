-- Estrutura do banco no Supabase.
-- Rodar uma vez no SQL Editor do projeto, antes do primeiro `npm run seed`.

create table if not exists catalogo (
  chave         text primary key,
  corpo         jsonb       not null,
  atualizado_em timestamptz not null default now()
);

create table if not exists obra (
  id             text primary key,
  corpo          jsonb       not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por text
);

create table if not exists usuario (
  id        text primary key,
  login     text        not null unique,
  nome      text        not null,
  perfil    text        not null check (perfil in ('admin','engenharia','projetista','consulta')),
  hash      text        not null,
  ativo     boolean     not null default true,
  criado_em timestamptz not null default now()
);

create table if not exists registro (
  id      bigserial primary key,
  quando  timestamptz not null default now(),
  login   text,
  quem    text,
  perfil  text,
  acao    text not null,
  alvo    text,
  detalhe text
);

create index if not exists idx_registro_quando on registro (quando desc);
create index if not exists idx_obra_atualizado on obra (atualizado_em desc);

-- O acesso é feito só pelo servidor, com a chave service_role.
-- O navegador nunca fala direto com o banco, então as tabelas ficam fechadas
-- para as chaves públicas: RLS ligado e sem policy alguma.
alter table catalogo enable row level security;
alter table obra     enable row level security;
alter table usuario  enable row level security;
alter table registro enable row level security;
