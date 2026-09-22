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
NEXLOG - Controle de Produção, Materiais e Instalação.html
script.js
styles.css
users.json
README.md
```

- `NEXLOG - Controle de Produção, Materiais e Instalação.html`: estrutura da aplicação
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
NEXLOG - Controle de Produção, Materiais e Instalação.html
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

## Persistência

Quando nenhuma integração externa está disponível, o sistema utiliza `localStorage` do navegador com a chave `nexlog_local_db_v1`.

Os dados permanecem após atualizar a página no mesmo navegador e computador. O botão `Salvar users.json`, na tela de Usuários, exporta a base atualizada de usuários para um arquivo JSON.

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

Esta versão é um protótipo local. A autenticação e a persistência funcionam no navegador, mas ainda não existe backend compartilhado entre computadores.

Para uso em produção, recomenda-se adicionar:

- autenticação real com hash de senha;
- banco relacional, como Supabase/PostgreSQL;
- armazenamento de fotos e documentos;
- políticas de segurança por perfil;
- sincronização entre usuários e dispositivos;
- geração de QR Code conectado a uma rota pública;
- histórico de auditoria no servidor.

## Licença

Projeto acadêmico para fins de demonstração e desenvolvimento.
