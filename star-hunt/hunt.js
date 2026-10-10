// Sample hunt for "Follow the Star". Stations are found in this order.
//
// Each station:
//   code       printed under its QR card and in the QR link (#s=CODE). Keep it random
//              so nobody can guess the next one.
//   hide       where to tape the card (only shown on the answer key).
//   clue       the riddle that leads to this station; kids is the simple version.
//   hint       shown only if the group asks for it.
//   story, scriptures, ponder   shown when the card is scanned.
//   challenge  optional group task that must be done before the next clue appears:
//                { type: 'order', prompt, items }        tap the items in order
//                { type: 'word', prompt, answers }       type any of the answers
//                { type: 'together', prompt, button }    do it, then tap the button
//                { type: 'gifts', prompt }               the finale: gifts for Him
//
// Scripture text is KJV / Book of Mormon. Double-check any you change in Gospel Library.
window.HUNT = {
  id: 'follow-the-star-sample',
  title: 'Follow the Star',
  intro: 'Long ago, prophets on both sides of the world watched for a sign. Tonight we follow the story of the birth of Jesus Christ, from the first prophecy to the manger. Solve each clue, find the hidden star card, and scan it to keep going. Nobody can skip ahead: the star only leads one way.',

  stations: [
    {
      code: 'DJQGW6',
      title: 'The Prophets Foretold',
      hide: 'Bookshelf: tucked inside or behind a set of scriptures.',
      clue: 'Long before the stable, long before the star, prophets wrote His name for people near and far. Go where the books stand shoulder to shoulder in a row, and the words of the prophets will tell you where to go.',
      kids: 'Go to the bookshelf.',
      hint: 'Look near the scriptures.',
      story: 'Hundreds of years before He was born, prophets in Jerusalem and in the Americas knew His name, His mother\'s name, and what He would do.',
      scriptures: [
        { ref: 'Isaiah 9:6', text: 'For unto us a child is born, unto us a son is given: and the government shall be upon his shoulder: and his name shall be called Wonderful, Counsellor, The mighty God, The everlasting Father, The Prince of Peace.' },
        { ref: 'Mosiah 3:8', bom: true, text: 'And he shall be called Jesus Christ, the Son of God, the Father of heaven and earth, the Creator of all things from the beginning; and his mother shall be called Mary.' },
      ],
      ponder: 'Isaiah and King Benjamin both knew His names long before He came. Which of His names means the most to you?',
      challenge: {
        type: 'order',
        prompt: 'Put Isaiah\'s names for Him in order. Pass the phone so everyone taps one.',
        items: ['Wonderful', 'Counsellor', 'The mighty God', 'The everlasting Father', 'The Prince of Peace'],
      },
    },
    {
      code: 'GUWAQY',
      title: 'An Angel Visits Mary',
      hide: 'Bathroom mirror: taped to the back or the bottom corner of the frame.',
      clue: 'An angel named Gabriel came with news from heaven to share. Find the glass that shows your face, and see who\'s standing there.',
      kids: 'Find a mirror.',
      hint: 'The mirror you use when you brush your teeth.',
      story: 'The angel Gabriel came to Mary in Nazareth. He told her she would be the mother of the Son of God. Mary was afraid at first, and then she said yes.',
      scriptures: [
        { ref: 'Luke 1:30–31', text: 'Fear not, Mary: for thou hast found favour with God. And, behold, thou shalt conceive in thy womb, and bring forth a son, and shalt call his name JESUS.' },
        { ref: 'Luke 1:37–38', text: 'For with God nothing shall be impossible. And Mary said, Behold the handmaid of the Lord; be it unto me according to thy word.' },
        { ref: 'Alma 7:10', bom: true, text: 'And behold, he shall be born of Mary, at Jerusalem which is the land of our forefathers, she being a virgin, a precious and chosen vessel, who shall be overshadowed and conceive by the power of the Holy Ghost, and bring forth a son, yea, even the Son of God.' },
      ],
      ponder: 'Mary said, "Be it unto me according to thy word." What is something you can say yes to Heavenly Father about, even when it feels hard?',
      challenge: {
        type: 'word',
        prompt: 'Finish Gabriel\'s promise: "For with God ______ shall be impossible."',
        answers: ['nothing'],
      },
    },
    {
      code: 'YRN455',
      title: 'Joseph\'s Dream',
      hide: 'Under a pillow on a bed.',
      clue: 'Joseph was troubled and didn\'t know what to do, till an angel came in a dream, and the dream was true. Look where heads rest when the day is done, and you\'ll learn the name of God\'s own Son.',
      kids: 'Look under a pillow.',
      hint: 'Check the beds.',
      story: 'Joseph was worried and did not know what to do. An angel came to him in a dream and told him not to be afraid. Joseph woke up and obeyed right away.',
      scriptures: [
        { ref: 'Matthew 1:20–21', text: 'Joseph, thou son of David, fear not to take unto thee Mary thy wife: for that which is conceived in her is of the Holy Ghost. And she shall bring forth a son, and thou shalt call his name JESUS: for he shall save his people from their sins.' },
        { ref: '2 Nephi 25:19', bom: true, text: 'For according to the words of the prophets, the Messiah cometh in six hundred years from the time that my father left Jerusalem; and according to the words of the prophets, and also the word of the angel of God, his name shall be Jesus Christ, the Son of God.' },
      ],
      ponder: 'Joseph obeyed as soon as he woke up (Matthew 1:24). The name Jesus means "the Lord saves." What has He saved you from?',
      challenge: {
        type: 'word',
        prompt: 'The angel said, "He shall save his people from their ____."',
        answers: ['sins', 'sin'],
      },
    },
    {
      code: 'Z6V3FF',
      title: 'The Road to Bethlehem',
      hide: 'By the front door: inside a boot or shoe.',
      clue: 'Caesar sent out a decree, so off on the road they went, with dusty feet and a long way to go before the day was spent. Find where the family\'s shoes and boots wait in a row by the door.',
      kids: 'Look in the shoes by the door.',
      hint: 'Check inside a boot.',
      story: 'Caesar Augustus ordered everyone to be counted in their family\'s city. Mary and Joseph traveled from Nazareth to Bethlehem, about 90 miles, just before the baby was born.',
      scriptures: [
        { ref: 'Luke 2:4–5', text: 'And Joseph also went up from Galilee, out of the city of Nazareth, into Judaea, unto the city of David, which is called Bethlehem; (because he was of the house and lineage of David:) To be taxed with Mary his espoused wife, being great with child.' },
        { ref: '1 Nephi 11:13', bom: true, text: 'And it came to pass that I looked and beheld the great city of Jerusalem, and also other cities. And I beheld the city of Nazareth; and in the city of Nazareth I beheld a virgin, and she was exceedingly fair and white.' },
      ],
      ponder: 'Six hundred years earlier, Nephi saw Mary in a vision. Who has helped carry you when you were tired?',
      challenge: {
        type: 'together',
        prompt: 'The youngest traveler carries the "donkey" (any stuffed animal) to the next clue, and everyone walks together. Nobody runs ahead!',
        button: 'Our donkey is ready',
      },
    },
    {
      code: 'VKSKH3',
      title: 'The House of Bread',
      hide: 'Pantry: inside or under the bread bag.',
      clue: 'The little town they traveled to has a name that means "House of Bread." Go find where our bread is kept, for that\'s where the star has led.',
      kids: 'Look where we keep the bread.',
      hint: 'Check the bread bag in the pantry.',
      story: 'Bethlehem means "House of Bread" in Hebrew. The prophet Micah said the Savior would come from this little town. Jesus later called Himself the Bread of Life.',
      scriptures: [
        { ref: 'Micah 5:2', text: 'But thou, Beth-lehem Ephratah, though thou be little among the thousands of Judah, yet out of thee shall he come forth unto me that is to be ruler in Israel; whose goings forth have been from of old, from everlasting.' },
        { ref: 'John 6:35', text: 'I am the bread of life: he that cometh to me shall never hunger; and he that believeth on me shall never thirst.' },
        { ref: '3 Nephi 20:8', bom: true, text: 'He that eateth this bread eateth of my body to their souls; and he that drinketh of this wine drinketh of my blood to their souls; and their souls shall never hunger nor thirst, but shall be filled.' },
      ],
      ponder: 'The Bread of Life was born in the House of Bread. How is Jesus like bread for our souls?',
    },
    {
      code: '9VHFH9',
      title: 'No Room in the Inn',
      hide: 'The fullest closet in the house: pinned to the inside of the door. Leave an empty toy manger here too.',
      clue: 'When they reached Bethlehem, every room was full and every door said no. Find a closet so stuffed that nothing else could go.',
      kids: 'Find the fullest closet.',
      hint: 'The closet nobody wants to open.',
      story: 'There was no room for them in the inn. The Son of God was born in a stable and laid in a manger, a feeding box for animals.',
      scriptures: [
        { ref: 'Luke 2:7', text: 'And she brought forth her firstborn son, and wrapped him in swaddling clothes, and laid him in a manger; because there was no room for them in the inn.' },
        { ref: '1 Nephi 11:16–17', bom: true, text: 'And he said unto me: Knowest thou the condescension of God? And I said unto him: I know that he loveth his children; nevertheless, I do not know the meaning of all things.' },
        { ref: 'Revelation 3:20', text: 'Behold, I stand at the door, and knock: if any man hear my voice, and open the door, I will come in to him, and will sup with him, and he with me.' },
      ],
      ponder: 'The King of Heaven came down to a manger. Take the empty manger with you; it won\'t stay empty for long.',
      challenge: {
        type: 'together',
        prompt: 'Each person names one thing they will clear out of their life to make more room for Jesus this Christmas.',
        button: 'Everyone has shared',
      },
    },
    {
      code: '4XYZCK',
      title: 'Shepherds and Angels',
      hide: 'Outside the back door: by the porch light (or just inside the door if it\'s snowy).',
      clue: 'Out in the fields the shepherds kept watch by night, till the sky filled with angels and glory and light. Step outside where the grass grows, or by the door if it\'s cold, and hear the good tidings the angels told.',
      kids: 'Go to the back door.',
      hint: 'Look by the porch light.',
      story: 'Shepherds were watching their sheep at night when an angel appeared, and the glory of the Lord shone around them. Then a multitude of angels praised God.',
      scriptures: [
        { ref: 'Luke 2:10–11', text: 'Fear not: for, behold, I bring you good tidings of great joy, which shall be to all people. For unto you is born this day in the city of David a Saviour, which is Christ the Lord.' },
        { ref: 'Luke 2:14', text: 'Glory to God in the highest, and on earth peace, good will toward men.' },
        { ref: 'Alma 13:22', bom: true, text: 'Yea, and the voice of the Lord, by the mouth of angels, doth declare it unto all nations; yea, doth declare it, that they may have glad tidings of great joy.' },
      ],
      ponder: 'Before you go on, sing one verse of "Angels We Have Heard on High" or "Far, Far Away on Judea\'s Plains" together.',
      challenge: {
        type: 'order',
        prompt: 'Put the angels\' song back together, in order.',
        items: ['Glory to God', 'in the highest,', 'and on earth', 'peace,', 'good will', 'toward men.'],
      },
    },
    {
      code: 'AFYV5G',
      title: 'Samuel on the Wall',
      hide: 'Top of the stairs: on the railing or the top step (or on top of a tall bookcase if there are no stairs).',
      clue: 'Far across the ocean, a brave prophet climbed up high, and told of a night with no darkness and a new star in the sky. Climb to the very top of the stairs, as high as you can go, and stand where Samuel stood when he called to those below.',
      kids: 'Go to the top of the stairs.',
      hint: 'Check the railing at the top.',
      story: 'Five years before Jesus was born, Samuel the Lamanite stood on the wall of Zarahemla and prophesied of the signs of His birth. Some people threw stones and shot arrows at him, but the Lord protected him.',
      scriptures: [
        { ref: 'Helaman 14:2', bom: true, text: 'And behold, he said unto them: Behold, I give unto you a sign; for five years more cometh, and behold, then cometh the Son of God to redeem all those who shall believe on his name.' },
        { ref: 'Helaman 14:3', bom: true, text: 'And behold, this will I give unto you for a sign at the time of his coming; for behold, there shall be great lights in heaven, insomuch that in the night before he cometh there shall be no darkness, insomuch that it shall appear unto man as if it was day.' },
        { ref: 'Helaman 14:5', bom: true, text: 'And behold, there shall a new star arise, such an one as ye never have beheld; and this also shall be a sign unto you.' },
      ],
      ponder: 'Samuel was brave enough to testify of Christ when people did not want to hear it. Where can you be brave about Jesus?',
      challenge: {
        type: 'word',
        prompt: 'Samuel said the Son of God would come in how many years?',
        answers: ['five', '5'],
      },
    },
    {
      code: 'GQJ7CJ',
      title: 'A Night Without Darkness',
      hide: 'Under the base of a lamp in the living room.',
      clue: 'The believers watched and waited: would the night stay bright? Find a lamp that turns the darkness into light.',
      kids: 'Look under a lamp.',
      hint: 'The lamp in the living room.',
      story: 'Some people said Samuel\'s prophecy had failed, and they set a day to put the believers to death. Nephi prayed all day, and the Lord answered him. That night the sun went down, and it did not get dark.',
      scriptures: [
        { ref: '3 Nephi 1:13', bom: true, text: 'Lift up your head and be of good cheer; for behold, the time is at hand, and on this night shall the sign be given, and on the morrow come I into the world, to show unto the world that I will fulfil all that which I have caused to be spoken by the mouth of my holy prophets.' },
        { ref: '3 Nephi 1:21', bom: true, text: 'And it came to pass also that a new star did appear, according to the word.' },
        { ref: 'John 8:12', text: 'I am the light of the world: he that followeth me shall not walk in darkness, but shall have the light of life.' },
      ],
      ponder: 'The same night the shepherds saw angels, the Nephites saw a night with no darkness. How does Jesus bring light to your life?',
      challenge: {
        type: 'together',
        prompt: 'Make it a night without darkness! Turn on every light you can find, then gather back here.',
        button: 'The house is glowing',
      },
    },
    {
      code: 'MFPWUZ',
      title: 'The Wise Men',
      hide: 'The east-facing window: taped to the bottom corner of the glass or the sill.',
      clue: 'Wise men from the east saw a new star rise. Find the window where the morning sun first greets your eyes.',
      kids: 'Find the window where the sun comes up.',
      hint: 'Ask Dad which way is east.',
      story: 'Wise men in the east saw His star and traveled a long way to find Him. The star went before them until it stood over the place where the young child was.',
      scriptures: [
        { ref: 'Matthew 2:2', text: 'Where is he that is born King of the Jews? for we have seen his star in the east, and are come to worship him.' },
        { ref: 'Matthew 2:11', text: 'And when they were come into the house, they saw the young child with Mary his mother, and fell down, and worshipped him: and when they had opened their treasures, they presented unto him gifts; gold, and frankincense, and myrrh.' },
      ],
      ponder: 'The wise men gave Him their treasures. What could you give Him?',
      challenge: {
        type: 'word',
        prompt: 'Name one of the three gifts the wise men brought.',
        answers: ['gold', 'frankincense', 'myrrh', 'mur', 'mir', 'frankinsense'],
      },
    },
    {
      code: 'M7W7HB',
      title: 'Come and See',
      hide: 'At the family nativity under the tree, with Baby Jesus hidden right next to it.',
      clue: 'Like the shepherds, come with haste, for your journey\'s nearly done. Go to the stable by the tree and find God\'s holy Son.',
      kids: 'Go to the Christmas tree.',
      hint: 'Look by the nativity.',
      story: 'The shepherds went with haste and found Mary, Joseph, and the baby lying in a manger, just as the angel said. The youngest person now places Baby Jesus in the manger.',
      scriptures: [
        { ref: 'Luke 2:16', text: 'And they came with haste, and found Mary, and Joseph, and the babe lying in a manger.' },
        { ref: 'John 3:16', text: 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.' },
        { ref: '2 Nephi 25:26', bom: true, text: 'And we talk of Christ, we rejoice in Christ, we preach of Christ, we prophesy of Christ, and we write according to our prophecies, that our children may know to what source they may look for a remission of their sins.' },
      ],
      ponder: 'Read Luke 2:1–20 together while the youngest places Baby Jesus in the manger.',
      challenge: {
        type: 'gifts',
        prompt: 'The wise men brought gifts. Each person adds one gift they will give the Savior this year.',
      },
    },
  ],

  // Fake star cards. Hide a few in easy spots to throw people off.
  decoys: [
    { code: 'BKFQDK', hide: 'Somewhere obvious, like the fridge door.' },
    { code: 'KYZ359', hide: 'On the TV remote.' },
  ],
  decoyMessage: {
    title: 'A false star!',
    text: 'King Herod set this one. He wanted the wise men to tell him where the child was so he could destroy Him. But the wise men were "warned of God in a dream that they should not return to Herod" (Matthew 2:12). Put this card back and follow your real clue.',
  },

  // Shown when someone scans a real card before the group has earned it.
  notYet: [
    'The star hasn\'t led you here yet.',
    'You\'ve wandered ahead of the shepherds.',
    'No room at this inn… yet.',
    'The wise men are still a long way off.',
  ],
};
