/* ============================================================
   Mil Palavras — word families
   Keyed by the exact Portuguese string, same as content.js.

   These are COLLOCATIONS AND SITUATIONAL NEIGHBOURS, not morphological
   derivations. The point is the company a word keeps: if you have met
   "o comboio", the words you will meet beside it are a estação, o bilhete,
   a linha, atrasado — not "comboiar". Authored deliberately, a few at a
   time; a card with no family simply doesn't show the section.
   ============================================================ */
window.MIL_FAMILY = {
  /* getting around */
  "o comboio":        [["a estação","the station"],["o bilhete","the ticket"],["a linha","the line"],["atrasado","delayed"]],
  "o autocarro":      [["a paragem","the stop"],["o passe","the travel pass"],["o motorista","the driver"],["a carreira","the route"]],
  "o elétrico":       [["a paragem","the stop"],["a linha","the line"],["o bilhete","the ticket"],["subir","to go up"]],
  "a estação":        [["o comboio","the train"],["a linha","the platform/line"],["o horário","the timetable"],["partir","to depart"]],
  "o bilhete":        [["a viagem","the journey"],["o passe","the pass"],["a estação","the station"],["comprar","to buy"]],
  "o aeroporto":      [["o avião","the plane"],["a viagem","the journey"],["a mala","the suitcase"],["chegar","to arrive"]],
  "o avião":          [["o aeroporto","the airport"],["voar","to fly"],["a viagem","the journey"],["aterrar","to land"]],
  "a paragem":        [["o autocarro","the bus"],["esperar","to wait"],["sair","to get off"],["a carreira","the route"]],
  "o carro":          [["conduzir","to drive"],["a estrada","the road"],["a chave","the key"],["estacionar","to park"]],

  /* the café and the table */
  "o café":           [["a chávena","the cup"],["o açúcar","the sugar"],["o balcão","the counter"],["a conta","the bill"]],
  "a chávena":        [["o café","the coffee"],["o chá","the tea"],["o pires","the saucer"],["cheia","full"]],
  "o pequeno-almoço": [["a torrada","the toast"],["o café","the coffee"],["a manteiga","the butter"],["cedo","early"]],
  "o almoço":         [["a sopa","the soup"],["o prato","the dish"],["a conta","the bill"],["a ementa","the menu"]],
  "o jantar":         [["a mesa","the table"],["o vinho","the wine"],["a sobremesa","the dessert"],["tarde","late"]],
  "a ementa":         [["o prato","the dish"],["o preço","the price"],["escolher","to choose"],["a conta","the bill"]],
  "a conta":          [["pagar","to pay"],["o troco","the change"],["o cartão","the card"],["a gorjeta","the tip"]],
  "o prato":          [["o garfo","the fork"],["a faca","the knife"],["a mesa","the table"],["o almoço","lunch"]],
  "o garfo":          [["a faca","the knife"],["a colher","the spoon"],["o prato","the plate"],["a mesa","the table"]],
  "a faca":           [["o garfo","the fork"],["cortar","to cut"],["o prato","the plate"],["afiada","sharp"]],
  "o vinho":          [["tinto","red"],["branco","white"],["o copo","the glass"],["a garrafa","the bottle"]],
  "a cerveja":        [["o copo","the glass"],["fria","cold"],["o balcão","the counter"],["a caneca","the tankard"]],
  "o pão":            [["a padaria","the bakery"],["a manteiga","the butter"],["fresco","fresh"],["a torrada","the toast"]],
  "o bacalhau":       [["cozido","boiled"],["as batatas","the potatoes"],["o Natal","Christmas"],["demolhar","to soak"]],

  /* shops and errands */
  "a padaria":        [["o pão","the bread"],["o bolo","the cake"],["fresco","fresh"],["abrir","to open"]],
  "o talho":          [["a carne","the meat"],["o frango","the chicken"],["pesar","to weigh"],["a senha","the queue ticket"]],
  "o supermercado":   [["o carrinho","the trolley"],["a lista","the list"],["a caixa","the checkout"],["o saco","the bag"]],
  "a farmácia":       [["o medicamento","the medicine"],["a receita","the prescription"],["de serviço","on duty"],["doente","ill"]],
  "os correios":      [["a carta","the letter"],["o selo","the stamp"],["enviar","to send"],["a encomenda","the parcel"]],
  "a senha":          [["esperar","to wait"],["a vez","the turn"],["o balcão","the counter"],["chamar","to call"]],
  "o cartão":         [["pagar","to pay"],["o dinheiro","the money"],["a conta","the bill"],["o código","the PIN"]],
  "o troco":          [["pagar","to pay"],["o dinheiro","the money"],["a moeda","the coin"],["a conta","the bill"]],
  "a loja":           [["comprar","to buy"],["o preço","the price"],["a montra","the window"],["fechar","to close"]],

  /* home */
  "a casa de banho":  [["a toalha","the towel"],["o espelho","the mirror"],["a torneira","the tap"],["o duche","the shower"]],
  "a cozinha":        [["o fogão","the stove"],["a mesa","the table"],["cozinhar","to cook"],["o frigorífico","the fridge"]],
  "a chave":          [["a porta","the door"],["fechar","to close"],["perder","to lose"],["a fechadura","the lock"]],
  "a cama":           [["dormir","to sleep"],["o quarto","the bedroom"],["o lençol","the sheet"],["acordar","to wake"]],

  /* people and place */
  "o amigo":          [["conhecer","to know/meet"],["o vizinho","the neighbour"],["juntos","together"],["a amizade","friendship"]],
  "o vizinho":        [["o prédio","the building"],["o andar","the floor"],["o barulho","the noise"],["ao lado","next door"]],
  "a morada":         [["a rua","the street"],["o número","the number"],["o código postal","the postcode"],["escrever","to write"]],
  "a esquadra":       [["a polícia","the police"],["a queixa","the report"],["perder","to lose"],["o documento","the document"]],
  "o hospital":       [["o médico","the doctor"],["a urgência","A&E"],["doente","ill"],["a consulta","the appointment"]],

  /* weather and body */
  "a chuva":          [["chover","to rain"],["o guarda-chuva","the umbrella"],["molhado","wet"],["o inverno","winter"]],
  "o calor":          [["o verão","summer"],["a sombra","the shade"],["a água","the water"],["suar","to sweat"]],
  "a garganta":       [["a dor","the pain"],["a farmácia","the pharmacy"],["a voz","the voice"],["engolir","to swallow"]],
  "o dente":          [["o dentista","the dentist"],["a dor","the pain"],["escovar","to brush"],["a boca","the mouth"]],

  /* time */
  "a segunda-feira":  [["o fim de semana","the weekend"],["o trabalho","work"],["cedo","early"],["a semana","the week"]],
  "o fim de semana":  [["o sábado","Saturday"],["o domingo","Sunday"],["descansar","to rest"],["passear","to stroll"]],
  "o sábado":         [["o mercado","the market"],["o fim de semana","the weekend"],["dormir","to sleep in"],["sair","to go out"]],
  "o domingo":        [["o almoço","lunch"],["a família","the family"],["descansar","to rest"],["fechado","closed"]],
};
