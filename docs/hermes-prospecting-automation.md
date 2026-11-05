# Respostas automáticas pelo Hermes

Extensão da ponte de leitura para a conta atual `@eugteodoro`, mantendo a
vinculação fixa de conexão/workspace e a allowlist privada existente.

## Rotas

- `POST /api/prospecting/updates`, com a credencial de leitura e `{handles}`:
  identidades e datas de atualização das conversas autorizadas. Não solicita
  prévias de mensagens. Confirma também a existência da tabela durável de envios.
- `POST /api/prospecting/reply`, com credencial exclusiva de resposta: aceita
  handle autorizado, ID da conversa, ID da mensagem recebida, fingerprint,
  tipo e texto. Nunca aceita um recipient ID arbitrário.

Novas variáveis, apenas em produção:

- `PROSPECTING_REPLY_TOKEN`: segredo exclusivo, diferente do token de leitura.
- `PROSPECTING_REPLIES_ENABLED`: `true` para liberar a rota de respostas.
- `PROSPECTING_WHATSAPP_URL`: link aprovado, mantido em configuração privada.

## Reservas e limites

`ProspectingReply` guarda uma reserva única por conta, conversa e mensagem
recebida. Não tem FK com exclusão em cascata. A reserva precede o único envio;
crash permanece SENDING e falha de transporte/confirmação permanece UNCERTAIN.
Nenhum desses estados é reenviado automaticamente. Uma duplicata confirmada
devolve somente o comprovante anterior, e nunca manda outra mensagem.

O servidor serializa as reservas por conta com advisory lock transacional,
intervalo mínimo de cinco minutos e até trinta reservas por dia de São Paulo.
O corpo é limitado, preços e links em continuações são recusados e o convite
WhatsApp deve ser exatamente o texto aprovado. Respostas têm até 1.000 bytes.

Conta, participantes, remetentes, última mensagem recebida, texto íntegro,
fingerprint e janela de 24 horas com margem de um minuto são conferidos.
O contexto é lido novamente depois da reserva, antes de enviar; a janela também
é reavaliada nesse momento. Uma recusa em qualquer mensagem do lote recebido
depois da última resposta própria impede envio. Triggers de DM existentes têm
prioridade: não responder se houver conflito com uma automação ativa.

## Publicação e operação

A migração `20261105140000_prospecting_replies` é estritamente aditiva. Antes de
executá-la, confirmar que é a única migração pendente. Não alterar processos,
webhooks, campanhas de conteúdo, conexão Meta, R2 ou publicação de Reels.

O perfil Hermes `prospeccao-edicao` executa o trabalhador local. O gateway desse
perfil roda só o agendamento; não conecta plataformas e não consome atualizações
do bot existente do Telegram. A primeira rodada estabelece baseline sem resposta
ao histórico. Novos primeiros contatos continuam pausados.

Pausa operacional imediata: controle `pause` do trabalhador. Pausar somente o
cron não interrompe uma rodada em andamento. Para fechar a rota no servidor,
desabilitar a variável de resposta em uma publicação autorizada; não remover
ou rotacionar a credencial de leitura para fazer isso.

## Validação

Testes incluem autenticação separada, conteúdo/contexto alterado, janela,
reservas concorrentes, opt-out em burst, erro antes do envio e erro ao persistir
a confirmação. A integração real deve provar prontidão, agendamento ativo e
baseline sem mensagens. Entrega real só pode ser declarada quando houver
mensagem recebida elegível e comprovante de envio retornado pela Meta.

Referência oficial do formato e requisito de interação recebida:
[Meta — Instagram Send API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).
