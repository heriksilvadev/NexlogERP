# NEXLOG

Sistema integrado de controle de produção, materiais, instalação e pós-venda.

O NEXLOG foi desenvolvido como protótipo de um sistema empresarial para o Projeto Integrador do SENAI. A Ordem de Serviço concentra o fluxo completo da operação:

Pedido -> Planejamento -> Materiais -> Estoque -> Produção -> CNC -> Qualidade -> Instalação -> Pós-venda -> Indicadores

## Funcionalidades

- Dashboard operacional com indicadores reais das OS cadastradas
- Ordens de Serviço com fluxo por etapas
- Clientes e materiais persistentes
- Controle de estoque, reservas e movimentações
- Planejamento em quadro operacional
- Cadastro e disponibilidade de ferramentas
- Terceirização e CNC
- Portões de controle para produção e instalação
- Qualidade, reprovação e retrabalho
- Registro de fotos e ocorrências na OS
- Pós-venda e histórico de atividades
- Notificações e central de pendências
- Usuários com perfis de acesso
- Interface responsiva para desktop e celular
- Tema escuro industrial com preto, grafite e amarelo

## Estrutura

```text
index.html
script.js
styles.css
users.json
README.md
```

- `index.html`: estrutura da aplicação
- `script.js`: lógica, navegação, regras de negócio e persistência
- `styles.css`: identidade visual e responsividade
- `users.json`: base inicial de usuários

## Como executar

O projeto não exige instalação de dependências.

1. Clone o repositório:

```bash
git clone https://github.com/heriksilvadev/NexlogERP.git
cd NexlogERP
```

2. Abra o arquivo HTML no navegador:

```text
index.html
```

Também é possível abrir o arquivo diretamente pelo Explorer do Windows.

## Acesso de demonstração

Administrador:

```text
Usuário: admin
Senha: Nexlog@123
```

Produção:

```text
Usuário: producao
Senha: Producao@123
```

Qualidade:

```text
Usuário: qualidade
Senha: Qualidade@123
```

## Supabase: banco e autenticação

O sistema usa Supabase para autenticação, API, persistência compartilhada e atualizações em tempo real.

1. Crie um projeto em https://supabase.com.
2. No SQL Editor, execute o arquivo `supabase-schema.sql`.
3. Em Authentication > Users, crie as contas com estes e-mails:
	- `admin@nexlog.app`
	- `producao@nexlog.app`
	- `qualidade@nexlog.app`
4. Copie a URL e a chave anon do projeto para `supabase-config.js`.
5. Publique os arquivos em GitHub Pages, Netlify ou Vercel.

As senhas ficam somente no Supabase Auth. A tabela `nexlog_records` armazena os dados operacionais em coleções JSONB, e as policies permitem acesso apenas a usuários autenticados. O botão `Salvar users.json` continua disponível apenas para exportação.

## Perfis

- **Administrador**: acesso geral
- **Atendimento**: clientes, OS e planejamento
- **Produção**: OS, planejamento, materiais, ferramentas e CNC
- **Estoque**: materiais, ferramentas, pendências e notificações
- **Qualidade**: OS, qualidade, pendências e indicadores
- **Instalação**: OS, planejamento, ferramentas e pendências
- **Pós-venda**: OS, pendências e indicadores

## Publicação

Repositório GitHub:

https://github.com/heriksilvadev/NexlogERP

Branch principal: `main`

## Limitações atuais

O controle de acesso por perfil ainda é aplicado na interface. Para uso em produção, recomenda-se restringir as policies do Supabase por perfil e adicionar:

- autenticação real com hash de senha;
- banco relacional, como Supabase/PostgreSQL;
- armazenamento de fotos e documentos;
- políticas de segurança por perfil;
- sincronização entre usuários e dispositivos;
- geração de QR Code conectado a uma rota pública;
- histórico de auditoria no servidor.

## Licença

Projeto acadêmico para fins de demonstração e desenvolvimento.
