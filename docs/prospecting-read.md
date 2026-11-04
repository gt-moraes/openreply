# Ponte de leitura da prospecção

## Escopo

`POST /api/prospecting/read` consulta uma conversa conhecida, sem enviar mensagens,
marcar leitura, mudar automações ou modificar dados comerciais. O POST transporta
o seletor no corpo para evitar nomes de prospects nos logs de URL.

Preparada em cópia isolada a partir de `b74cecd041d0300c93250b92847a484f056f29cc`.
Essa é a base local verificada, não uma afirmação sobre o commit em produção.
Não incluir as alterações locais de publicação de Reels no mesmo deploy.

## Configuração de servidor

Variáveis novas e exclusivas desta integração:

- `PROSPECTING_API_TOKEN`: segredo aleatório de 32 a 512 caracteres.
- `PROSPECTING_ACCOUNT_ID`: ID interno da conexão de `@gteodoro.ia`.
- `PROSPECTING_WORKSPACE_ID`: workspace proprietário dessa conexão.
- `PROSPECTING_ALLOWED_HANDLES`: lista privada de 1 a 100 handles, separados por
  vírgula, compatível com contatos ativos do CRM. Não colocar a lista no Git.

A ausência ou inconsistência de qualquer variável mantém o serviço fechado.
Conta, workspace e provedor Meta são verificados antes da consulta. A integração
não reutiliza tokens de publicação, cookies de navegador ou API keys de modelos.
Os perfis excluídos por Guilherme são bloqueados também nesta camada.

## Contrato

Cabeçalhos: `Authorization: Bearer <segredo exclusivo>` e
`Content-Type: application/json`. Corpo máximo de 512 bytes:

```json
{"handle":"nutri.fixture"}
```

O exemplo é fictício. A resposta contém a conversa, data da observação e mensagens
com `id`, `author: self|lead|unknown`, `authorConfirmed`, `text`, `truncated` e
`createdAt`. Não inclui credenciais nem IDs de workspace.

A descoberta pede apenas `id,participants,updated_time`, limitada às 50 conversas
recentes. Somente uma conversa individual com conta e handle comprovados permite
buscar até 20 mensagens recentes. Sem correspondência única, responde 409. Isso
não significa que a conversa não exista; ela pode estar fora da página consultada.
Não há paginação automática, inferência de remetente, envio ou confirmação de que
uma conversa é comercial. Histórico é sempre marcado como limitado.

Respostas usam `Cache-Control: no-store`. Erros do provedor não são serializados
nem registrados, pois podem conter dados ou tokens. Não há repetição automática.

## Validação e publicação

Executar `prisma generate` apenas para gerar tipos locais; esta ponte não cria
migração. Depois executar testes, TypeScript e ESLint. A validação usa dados
fictícios e mocks HTTP; não prova a ponte publicada nem o envio de DMs.

Antes de publicar, confirmar o commit de produção e revisar somente os novos
arquivos desta integração. Configurar segredo e IDs em ambiente privado somente
após autorização da mudança em produção. Preservar automações, webhook, workers,
conexões e variáveis existentes. Validar um único contato ativo depois do deploy,
sem enviar mensagens, e verificar que um perfil não autorizado é recusado.

Revogação: remover `PROSPECTING_API_TOKEN` fecha esta ponte sem desconectar o
Instagram. Nenhuma automação existente depende dessa variável nova.
