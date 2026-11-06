![Apresentação social](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/social-preview.png)

# dsh-context

[简体中文](https://github.com/bowenliang123/dsh-context/blob/main/README.md) · [English](https://github.com/bowenliang123/dsh-context/blob/main/README_en.md) · [日本語](https://github.com/bowenliang123/dsh-context/blob/main/README_ja.md) · [Español](https://github.com/bowenliang123/dsh-context/blob/main/README_es.md) · [Français](https://github.com/bowenliang123/dsh-context/blob/main/README_fr.md) · [Deutsch](https://github.com/bowenliang123/dsh-context/blob/main/README_de.md) · [Русский](https://github.com/bowenliang123/dsh-context/blob/main/README_ru.md) · [Português](https://github.com/bowenliang123/dsh-context/blob/main/README_pt.md)

[![versão do npm](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![estrelas no GitHub](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![dshfind](https://dshfind.com/api/badge/bowenliang123/dsh-context)](https://dshfind.com/en/plugins/bowenliang123/dsh-context?ref=badge)

**O melhor [plugin do DeepSeek Harness](https://www.deepseek.com/harness/) para insights e gerenciamento do contexto do agente.**

> Recomendado e favoritado pela equipe do DeepSeek Harness, [@tianyicui](https://github.com/tianyicui) e [@turtle1999](https://github.com/turtle1999) — veja [esta publicação no X](https://x.com/tianyi/status/2105256532657267119).

O [`dsh-context`](https://www.npmjs.com/package/dsh-context) oferece recursos completos de gerenciamento do ciclo de vida do contexto.
- **Página Insights de contexto** — a visão geral entre sessões como um painel de primeiro nível na barra lateral (ao lado de Plugins e Tarefas de automação): faixa de KPIs com gráfico de uso de tokens/custos de 7 dias, mapa de calor de atividade, anel de composição agregada e cartões de sessão filtráveis que levam diretamente a qualquer sessão.
- **Aba Contexto** — um painel de contexto na interface com estatísticas, composição, tendência, eventos, mensagens e comandos do DeepSeek Harness.
- **Aba Frota** — a página da família de agentes: o agente atual, seus pais e todos os subagentes, cada um com um cartão ao vivo.
- **Painel Contexto** — o mesmo painel como uma aba da barra lateral direita: selecione **Contexto** na página de guia da barra lateral e o painel abre ao lado do chat, incluindo a rede de agentes.
- **Comando `/context`** — o comando de barra mostra o modelo de contexto para a composição atual e a evolução recente do contexto.

▶️ **Apresentação em vídeo de 4 minutos** — [assista no Bilibili](https://www.bilibili.com/video/BV1bn4K6TEEV/) (em chinês).

[![dsh-context e DeepSeek Harness: composição de contexto, evolução e equipes multiagente](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/video-cover.jpg)](https://www.bilibili.com/video/BV1bn4K6TEEV/)

## Instalar / Atualizar

### Instalar no DeepSeek Harness web ou desktop

Digite `dsh-context` na caixa de pesquisa do assistente **Adicionar plugin** e clique em **Instalar**:

![Assistente_para_adicionar_plugin](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/add-plugin-wizard.png)

### Instalar com a CLI `dsh`

Instale o plugin [`dsh-context`](https://www.npmjs.com/package/dsh-context) do [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh):

```sh
dsh plugin --profile web add dsh-context
```

Ou atualize o plugin `dsh-context`:

```sh
dsh plugin --profile web update dsh-context@latest
```

Depois, inicie a interface web com `dsh web`. Sem etapa de build, sem reinicialização.

## Como usar

Cinco superfícies, uma história — o que seu agente está carregando, como chegou a isso e o que fez com isso:

| Onde | O que você obtém |
| --- | --- |
| **Página Insights de contexto** | Todas as sessões em uma visão: uso, custo, acerto de cache, atividade diária e perfis de contexto por sessão — filtrados por intervalo, dia, grupo ou pesquisa, com um clique para entrar. |
| **Aba Contexto** | O painel completo: estatísticas, composição, tendência por requisição, eventos, atividade de arquivos e execuções de comandos — em cada sessão. |
| **Aba Frota** | A rede de agentes: o agente atual, seus pais e todos os subagentes, ao vivo. |
| **Comando `/context`** | Um modal centralizado com a mesma composição e o mesmo navegador de contexto, sem sair do chat. |
| **Cartão de preferências** | Padrões por usuário: a entrada do painel, o intervalo dos Insights, os padrões de tendência e ordenação, e o prefixo/sufixo do prompt do sistema adicionados em torno de cada sessão. |

## 🗂️ A página Insights de contexto

Clique em **Insights de contexto** na lista de painéis da barra lateral — no mesmo nível de **Plugins** e **Tarefas de automação** — e a página abre como um painel completo na coluna central:

![A página Insights de contexto](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-dashboard.png)

| Seção | A pergunta que ela responde |
| --- | --- |
| **Faixa de KPIs** | Quanto estou usando — sessões ativas no intervalo escolhido (7 dias / 30 dias / tudo), com tokens faturados, custo estimado, taxa de acerto de cache e turnos agregados pelo dia em que cada etapa começou; execuções de ferramentas e tempo ativo cobrem toda a vida útil dessas sessões e de seus subagentes, correspondendo ao cartão de tempo. |
| **Gráfico de uso de 7 dias** | Quando gastei quanto — tokens faturados e custo estimado de cada um dos últimos 7 dias como um par de barras, agregados pelo dia de início de cada requisição em sua sessão (não pelo último dia ativo da sessão). |
| **Mapa de calor de atividade** | Quando realmente trabalho — tokens faturados diários das últimas 8 semanas; clique em um dia para filtrar as sessões e limitar os três cartões de totais àquele dia. |
| **Carregamentos de skills** | Quais skills carreguei, com que frequência e há quanto tempo — carregamentos por skill no intervalo; clique em uma para filtrar as sessões que a carregaram. |
| **Chamadas de ferramentas** | Quais ferramentas foram executadas, com que frequência e há quanto tempo — execuções por ferramenta no intervalo a partir do registro diário; clique em uma para filtrar as sessões que a executaram. |
| **Execuções de comandos** | Quais programas foram executados, com que frequência e há quanto tempo — execuções de comandos por programa no intervalo, contadas no despacho; clique em um para filtrar as sessões que o executaram. |
| **Entrada de configurações** | O chip no cabeçalho da página — o mesmo salto protegido às preferências deste plugin do cartão Informações do plugin na aba Contexto. |
| **Composição do contexto** | Para onde foram os tokens faturados do intervalo escolhido, divididos pelas categorias faturadas do cartão Tokens (Chamadas de ferramentas, Raciocínio, Respostas, …). |
| **Cartões de sessão** | O perfil de cada sessão sob os quatro cartões: anel de composição, tokens faturados, turnos, custo e sua trilha de grupo de workspace / projeto — ordenados por recência, tokens ou tamanho do contexto, com pesquisa e agrupamento por workspace. Clique em um cartão para abrir a sessão. |


## 📊 A aba Contexto

Abra qualquer sessão e clique na aba **Contexto**:

![Visão geral do painel Contexto](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

| Cartão | A pergunta que ele responde |
| --- | --- |
| **Estatísticas de contexto** | Turnos, etapas, entradas humanas, chamadas de ferramentas ao vivo — além de um custo estimado a partir dos preços de tabela do models.dev (passe o mouse sobre `?` para ver as tarifas por milhão; somente o DeepSeek separa pico/fora de pico: suas tarifas listadas são da faixa fora de pico, e os períodos de pico são faturados a 2×). |
| **Estatísticas de tokens** | Para onde foram os tokens faturados — o mesmo total da linha de estatísticas do chat sob o editor, dividido em Prompt do sistema, Esquemas de ferramentas, Mensagens do usuário, Contexto injetado, Injeções de skills, Chamadas de ferramentas, Raciocínio e Respostas. Chamadas de ferramentas reúne os nomes e argumentos das chamadas (reproduzidos no prompt e gerados na saída) com os resultados retornados por essas ferramentas; Respostas separa o texto das respostas do modelo do mesmo conteúdo e saída do assistente; Raciocínio separa seu pensamento da mesma forma; a taxa de acerto de cache da sessão fica no canto. |
| **Estatísticas de tempo** | Como o tempo ativo se dividiu entre chamadas ao modelo, execuções de ferramentas e sobrecarga. |
| **Contexto atual** | O que está na janela *agora mesmo*. |
| **Tendência de contexto** | O tamanho de cada requisição — e sua história. |
| **Navegador de contexto** | Com o que qualquer requisição foi *realmente* montada. |
| **Eventos de contexto** | Quando e por que a janela mudou. |
| **Atividade de arquivos** | O que o agente *fez* com seus arquivos. |
| **Execuções de comandos** | O que o agente executou, como cada execução terminou e de quais programas ele mais dependeu. |

A estimativa de custo segue um conjunto documentado de regras: [Como os preços dos modelos são mapeados](docs/model-pricing-mapping.md).

A ocupação e a composição em destaque leem as **mesmas projeções oficiais do medidor de tokens do anel de contexto do editor do chat** (`contextPressure` / `contextBreakdown`), portanto os valores sempre correspondem ao que o anel mostra — a porcentagem do cartão é essa mesma ocupação, exibida com uma casa decimal.

A célula Rede de agentes do cartão **Estatísticas de contexto** (tokens faturados e custo estimado de toda a família) salta para a aba **Frota**. Suas pílulas Entrada / Saída também são links de salto: **Entradas humanas** abre o **Navegador de contexto** nas suas mensagens, e **Lidos / Gravados / Pesquisados / Imagens** levam ao cartão **Atividade de arquivos** com esse tipo selecionado.

### Estatísticas de contexto

#### Estatísticas de tokens e Estatísticas de tempo
![Estatísticas_de_tokens_e_Estatísticas_de_tempo](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/token-stats-and-timing-stats.png)

#### Estatísticas de contexto
![Estatísticas_de_contexto](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-stats.png)


### 🧱 Contexto atual — o que há na janela de contexto agora

![Cartão Contexto atual](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/current-context.png)

Uma barra empilhada de seis cores comparada à janela completa do modelo (as duas máscaras hachuradas no final = reserva da compactação automática: sua margem e, depois, a janela de saída reservada da requisição): prompt do sistema, esquemas de ferramentas, mensagens do usuário, contexto injetado, respostas do assistente, resultados de ferramentas — cada um com seu valor de ≈tokens e sua participação. Quando uma conversa começa a se degradar, é aqui que você vê *qual parte* é responsável.

### 📈 Tendência de contexto — como o contexto cresceu e evoluiu por turno ou etapas

![Tendência de contexto com o resumo da etapa](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-trend.png)

Uma barra empilhada por requisição ao modelo — mais detalhada que por mensagem — para acompanhar o crescimento da janela turno a turno:

- **✨ Resumo da etapa** — três linhas em linguagem simples sob o gráfico: **Usuário** recupera a mensagem que abriu o turno, **Entrada** lista o que acabou de entrar (normalmente os resultados anteriores das ferramentas), **Resposta** mostra a resposta e/ou as ferramentas chamadas. Clique em uma linha para abrir exatamente essa mensagem no Navegador de contexto.
- **✂ marca os eventos** — compactações e podas são fixadas na barra em que aconteceram, para que as quedas se expliquem por si.
- **Leia do seu jeito** — granularidade **Etapa / Turno**, **Total** (composição cumulativa) ou **Delta** (mudança com sinal de cada requisição), e rolagem lateral por toda a sessão. No modo Delta, o crescimento se acumula acima da linha de base e uma compactação mergulha abaixo dela:

![Tendência de contexto no modo Delta](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-delta.png)

- **Visão geral** — um botão comprime toda a sessão (etapas ou turnos) na largura do painel como uma fita empilhada contínua: cada queda de compactação e mudança de composição em uma visão, sem rolagem lateral, nada extra para carregar. Bandeiras marcam os quartis e o período completo; passe o mouse para percorrer, passe sobre uma faixa para destacar essa categoria em toda a fita; clicar fixa a etapa e abre a categoria dessa faixa no navegador (mutuamente exclusivo com o modo DNA e Adaptativo).
- **Passar o mouse e fixar** — percorra para ver um tooltip instantâneo; clique para fixar o detalhamento completo, com **Prompt / Saída / Cache** reais informados pelo provedor ao lado das estimativas.
- **Vinculação ao vivo** — passar o mouse sobre uma barra mostra uma prévia do contexto montado daquela etapa no Navegador de contexto ao lado do gráfico; sair do gráfico retorna à sua própria seleção.

### 🧭 Navegador de contexto — abra a caixa de qualquer requisição

Escolha **Ao vivo (próxima requisição)** ou qualquer etapa retida e explore com o que essa requisição foi montada: sete categorias recolhíveis se expandem em uma linha por elemento com seu custo em tokens, e cada elemento se expande novamente em seu **conteúdo real** — o prompt do sistema, o esquema JSON de cada ferramenta, texto das mensagens, raciocínio, argumentos de ferramentas e saídas de ferramentas. O conteúdo de skills (o catálogo de skills disponíveis, invocações de `/skill` e carregamentos da ferramenta `skill`) tem sua própria categoria **Injeções de skills**, para que a pegada de contexto de uma skill furtiva não fique escondida nos grupos de contexto injetado e resultados de ferramentas.

- **Quem fornece cada ferramenta** — cada linha de esquema de ferramenta traz um chip de origem na melhor medida possível: pacotes originais `tool-*`, pacotes de capacidades `dsh-*`, proxies `mcp:<server>` ou o plugin exato observado ao vivo em `tools.register()`. Ordene por **tamanho / nome** e filtre cada categoria pelos seus próprios campos pesquisáveis:

![Esquemas de ferramentas com chips de origem, filtro e ordenação](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tools.png)

- **Filtre respostas do assistente por tipo** — a caixa de pesquisa da categoria do assistente traz chips **Raciocínio / Ferramentas / Resposta**, cada um contando as respostas desse tipo nos resultados da pesquisa atual (uma resposta pode ter vários); clique em um para manter somente as respostas correspondentes, clique novamente para limpar:

![Respostas do assistente com chips de filtro por tipo](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-assistant-kinds.png)

- **Resultados de ferramentas abrem a chamada completa** — nome e argumentos da ferramenta com seu status **OK/erro**, o corpo do resultado com contagem de linhas e um botão **Bruto / Markdown**:

![Um resultado de ferramenta expandido com o botão Bruto/Markdown](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tool-result.png)

- **Anexos são renderizados como cartões ordenados** — os blocos `image` e `file` de uma mensagem ficam juntos na ordem em que a mensagem os carrega, um cartão para cada: imagens com miniatura, dimensões, tamanho armazenado e a estimativa oficial de tokens de imagem do DeepSeek; outros arquivos com seu glifo de tipo, extensão e tamanho armazenado. Um clique abre o anexo na própria coluna de visualização do dsh (visualizadores de markdown, código, PDF, documentos do Office e imagens), sob o nome real do arquivo:

![Cartões de anexos de imagem com dimensões, tamanho armazenado e estimativa de tokens](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-images.png)

- **Diff em relação ao turno anterior** — selos de delta com sinal por categoria (`+N` itens, `±Nk` tokens) mostram imediatamente o que um turno adicionou ou recuperou. Etapas anteriores a uma compactação são reconstruídas a partir do arquivo de mensagens removidas — e o cartão informa quando a composição de uma etapa é apenas aproximada.

- **O modo DNA apresenta todo o contexto de forma plana** — a barra desenha uma faixa por item na ordem de leitura do modelo e, abaixo, os mesmos itens formam uma lista plana com a mensagem mais recente no topo (o modelo lê da mais antiga para a mais recente, portanto a lista percorre essa ordem de baixo para cima): cada linha traz sua posição no prompt (`#12`), categoria, etapa de introdução e custo em tokens, e se expande no mesmo conteúdo completo; os esquemas de ferramentas e o prompt do sistema encerram a lista como duas linhas de grupo. O cartão termina alinhado aos cartões de composição + tendência ao lado — uma sessão totalmente nivelada rola internamente em vez de inundar a página.

### ⚡ Eventos de contexto — quando e por que a janela mudou

![Eventos de contexto com uma compactação](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-events.png)

Cada injeção, compactação, poda, troca de modelo e alternância do modo de plano — identificada com seu produtor (arquivo de instruções, id do plugin, nome da skill), seu delta líquido de tokens (compactações mostram o que recuperaram), turno/etapa e horário. Os chips **Injetar / Compactar / Podar / Trocar / Modo** filtram o log por tipo, cada um com sua contagem de eventos de toda a sessão.

### 📁 Atividade de arquivos — o que o agente fez com seus arquivos

![Atividade de arquivos](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/file-activity.png)

Uma linha por arquivo tocado — lido, gravado ou pesquisado — agregada até a etapa que você escolher no gráfico de tendência:

- **Contagens por finalidade** com chips no cabeçalho que também funcionam como filtros (**Lidos / Gravados / Pesquisados / Imagens**) e uma caixa de pesquisa por caminho.
- **Deltas de linhas** — cada `edit`/`write` contribui com sua pegada estimada de `+adicionadas / −removidas`, por arquivo e somada.
- **Todos os modos contam** — ferramentas nativas, o `str_replace_editor` da predefinição Minimal e as chamadas aninhadas em programas `run_code` do PTC são reunidos em linhas por ferramenta.
- **Pesquisas chegam a arquivos reais** — arquivos correspondentes ganham suas próprias linhas de operações com contagens de ocorrências.
- **Clique em uma linha** para expandir seu log completo de operações — cada operação salta diretamente para o resultado exato da ferramenta no Navegador de contexto.
- **Clique no nome de um arquivo** para abrir sua visualização na barra lateral direita, exatamente como a barra lateral Arquivos integrada faz — o mesmo visualizador, o mesmo comportamento de uma aba por arquivo. Em um harness sem essa coluna, o nome abre no seu sistema como antes.

### 🖥️ Execuções de comandos — o que o agente executou

![Execuções de comandos](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/command-executions.png)

Cada execução de shell e código com seu status, tempo de execução e marca de etapa, além de um resumo da sessão, atalhos de atenção e uma classificação de programas. Os fatos de atenção e a classificação continuam abrangendo toda a sessão enquanto a pesquisa e os chips de status restringem a lista. Cada clique na faixa lateral escreve seu recorte na caixa de pesquisa — clicar em um programa preenche e destaca o programa, e clicar novamente limpa ambos — para que a caixa sempre mostre o que está filtrando a lista.

## 🚢 A aba Frota

Abra qualquer sessão e clique na aba **Frota** (à direita de **Contexto**) — a família de agentes em uma página própria: uma faixa de resumo, os cartões **Rede de agentes** e **Colaboração entre agentes**, e abaixo **Tarefas de trabalho em equipe** e **Inspeção de eventos**.

![A página Frota para uma equipe de seis agentes: resumo da frota, Rede de agentes, Colaboração entre agentes, Tarefas de trabalho em equipe e Inspeção de eventos](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/fleet-overview.png)

A faixa de resumo conta agentes, agentes em execução, itens de trabalho e mensagens. Escolher um agente no grafo ou em uma faixa restringe a visão de colaboração a esse agente, então a página responde por um membro de cada vez.

### 🕸 Rede de agentes — o retrato da família

O agente atual, seus pais e cada subagente — um cartão por agente: seu título, o tamanho do contexto ao vivo e a ocupação da janela, uma barra de composição, e há quanto tempo está em execução e quantos passos deu. As arestas saem de cada pai na cor da linhagem — passe o mouse sobre um cartão para iluminar toda a sua cadeia e ler o detalhamento completo na faixa de detalhes; clique em um nó para destacá-lo. Agentes em execução respiram com um pulso verde na aresta de entrada e giram o próprio indicador rotativo do harness ao lado do título, que se assenta no mesmo ponto verde que a lista de subagentes do cabeçalho usa quando o trabalho termina; painéis estreitos dobram a família em linhas organizadas — nunca uma barra de rolagem horizontal.

### 🛰 Colaboração entre agentes — a família em uma única linha do tempo

Cada agente ganha uma faixa em uma linha do tempo única: mensagens entre agentes, marcadores de tarefas da equipe e registros de delegação, com as faixas silenciosas recolhidas atrás de um botão. Números de tarefa identificam uma tarefa entre faixas — números repetidos são a mesma tarefa — e passar o mouse vincula os registros que andam juntos. **Earliest / Latest** inverte a ordem, a busca restringe as faixas e clicar em uma tarefa filtra a linha do tempo e a revela.

### ✅ Tarefas de trabalho em equipe — quem está fazendo o quê

O quadro **Tarefas de trabalho em equipe** reúne tarefas da equipe e delegações a subagentes — grupos por proprietário, filtros de status (Todas / Em andamento / Pendentes / Concluídas) e links de bloqueio que acendem toda a cadeia de pré-requisitos ao focar uma tarefa. Cada cartão traz seu proprietário, resumo, escopos de escrita e resposta final; clique em uma tarefa para abrir sua descrição completa no local, bruta ou renderizada.

### 📡 Inspeção de eventos — quem disse o quê a quem

O cartão **Inspeção de eventos** lê os logs de sessão da família automaticamente — sem etapa de varredura. Mensagens, relatórios e registros de delegação se filtram em um único fluxo: selecione um nó da linha do tempo ou um registro do fluxo para ver o registro completo — o log de sessão de onde veio e sua sequência, um aviso quando o runtime escreveu o encerramento em vez do filho, o relatório de encerramento completo (com seu resultado estruturado ou diagnóstico) e cartões de participantes que abrem o chat desse agente na barra lateral ou na visão completa. Filtre por tipo ou texto, e a seleção compartilhada de agente restringe todo o hub.

O painel **Contexto** da barra lateral direita mantém o mesmo cartão inline, então a família fica a um clique enquanto você lê o chat. Não quer a aba? Desative **Aba Frota** no cartão de preferências — o cartão continua vivendo nesse painel, e a célula de família da aba Contexto o abre ali sempre que uma barra lateral é servida.

## ⌨️ Comando `/context`

Digite `/context` (ou escolha no menu `/`) e pressione Enter:

![Menu de comandos de barra com o comando context](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command-entry.png)

Uma caixa de diálogo centralizada abre com o cartão **Composição atual** e o **Navegador de contexto** — a mesma barra de composição, seletor por etapa e selos de diff `vs turno anterior` da aba:

![O modal /context](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command.png)

## ⚙️ Configurações

O cartão de preferências **Contexto** contém as configurações por usuário deste plugin — a **Entrada do painel Contexto** (a aba de conversa **Contexto**, o painel da barra lateral direita, ambos ou Ocultar para nenhum — o salto da linha de resposta acompanha essa escolha), o botão Mostrar/Ocultar da própria aba **Frota** (a entrada do painel nunca a bloqueia), o intervalo padrão de **Insights de contexto** (Hoje / Últimos 7 dias / Últimos 30 dias / Tudo, Últimos 30 dias até ser alterado; escolher uma predefinição na página a grava), a granularidade da tendência (Etapa/Turno), o modo da tendência (Total/Delta), a curva de duração da tendência (exibida por padrão), o limiar de etapas para a visão geral automática da tendência, a base de diff do Navegador de contexto, a ordenação de ferramentas e Atividade de arquivos, e o botão Mostrar/Ocultar dos Insights de contexto. Ele fica na página **Plugins**: entrada **Plugins** da barra lateral → página do pacote **dsh-context** → sua seção **Configuração** (o cartão é fornecido pelo formulário Config ativo da entrada).

As linhas **Prompt do sistema · Prefixo / Sufixo** contêm texto livre adicionado ao início / fim do prompt do sistema de cada sessão, para todos os agentes (incluindo subagentes) — uma persona ou regra comportamental por implantação que acompanha a própria montagem de prompt do harness. As edições se aplicam a partir do próximo turno; deixe uma linha vazia para desativá-la.

Os botões de predefinição dos Insights de contexto gravam a escolha como padrão armazenado; todos os outros botões dentro dos gráficos e cartões permanecem por visualização e nunca sobrescrevem a preferência armazenada.

![O cartão de configurações do Contexto](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/settings.png)

## Informações úteis

- **Pegada do cache** — o plugin salva checkpoints apenas de um resumo compacto por sessão (composição, contagens, custo/tempo, informações do modelo) no cache de projeção do dsh; os detalhes pesados por evento (texto das superfícies, detalhamentos de requisições, operações de arquivos, programas de comandos, intervalos) são reconstituídos a partir do log durável quando um painel precisa deles, para que o cache permaneça pequeno mesmo em sessões longas. As visualizações de detalhes são limitadas (etapas 1500 · turnos 300 · eventos 400 · nós de superfície 2000 · arquivo 400 · operações de arquivos 400 · comandos 400).
- **Estimativas versus valores reais** — os valores por categoria usam a própria heurística de densidade fixa do dsh (a mesma do seu medidor de tokens integrado); os detalhes fixados da tendência mostram os valores reais informados pelo provedor ao lado deles, e o cartão Tokens combina suas participações de composição estimadas com ≈ ao total faturado exato do provedor.
- **Compatibilidade** — funciona com `@deepseek-ai/dsh` a partir de **0.2.0-rc.2** (as linhas `0.2.0` e `0.2.1` verificadas em suas versões rc.2, e a linha `0.2.2` em sua versão rc.1), a geração de log de sessão V4, por um único caminho de código orientado pela estrutura. A matriz por versão e como ela é verificada: [docs/compatibility.md](docs/compatibility.md).
- **I18n** — interface em 简体中文, English, 日本語, Español, Français, Deutsch, Русский e Português (trocar de idioma exige dsh 0.2.2+; as linhas suportadas anteriores oferecem apenas chinês e inglês).

## Gostou?

Se o `dsh-context` ajudou você a entender o que seu agente está carregando, uma ⭐ no [GitHub](https://github.com/bowenliang123/dsh-context) será muito apreciada — e issues/PRs são bem-vindos!

## Licença

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
