import { describe, expect, it } from 'vitest';
import {
  asksPrice,
  isCloser,
  isGreeting,
  isLikelyHallucination,
  isMenuRequest,
  isWave,
  moreOfThis,
  newAddressIn,
  newQuantity,
  readAddress,
  wantsAddressChange,
  wantsBot,
  wantsMethod,
  wantsPerson,
} from './intents';

describe('greetings', () => {
  it.each([
    'hi',
    'Hi!',
    'hiii',
    'hello',
    'Hello!!',
    'HELLO',
    'hey',
    'heyy',
    'hallo',
    'hola',
    'yo',
    'hi there',
    'hello there',
    'hey there',
    'Hi 👋',
    'Hello 👋🏽',
    'hi again',
    'hello again',
    'hi sir',
    'hello madam',
    'hello boss',
    'hi team',
    'hi all',
    'hello everyone',
    'good morning',
    'Good morning!',
    'good afternoon',
    'good evening',
    'good day',
    'morning',
    'Good morning sir',
    'good morning madam',
    'good evening team',
    'hello good morning',
    'hi good evening',
    'Hello, good morning',
    'hi, good afternoon',
    'hey, good evening!',
    'oli otya',
    'Oli otya?',
    'howdy',
    'greetings',
    'hello katale',
    'hi please',
    'hi friend',
    'hello dear',
    'hi hi',
    'hello hello',
    'hey hi',
  ])('%s is a greeting', (text) => {
    expect(isGreeting(text)).toBe(true);
  });

  it.each([
    'hi do you have baskets',
    'hello I want a basket',
    'good morning, how much is the wallet',
    'hey can I pay on delivery',
    'hi there is a problem with my order',
    'hello basket',
    'morning coffee',
    'good coffee',
    'hi how are you',
    'help',
    'menu',
    'yes',
    '1',
    '',
    '👋',
  ])('%s is not a greeting', (text) => {
    expect(isGreeting(text)).toBe(false);
  });

  it('reads waves, menu requests and closers', () => {
    expect(isWave('👋')).toBe(true);
    expect(isWave('👋🏽')).toBe(true);
    expect(isWave('👍')).toBe(false);
    expect(isWave('hi 👋')).toBe(false);
    expect(isMenuRequest('menu')).toBe(true);
    expect(isMenuRequest('Help!')).toBe(true);
    expect(isMenuRequest('help me find a basket')).toBe(false);
    expect(isCloser('thanks')).toBe(true);
    expect(isCloser('Thank you!')).toBe(true);
    expect(isCloser('ok thanks')).toBe(true);
    expect(isCloser('thanks, can I add one more')).toBe(false);
  });
});

describe('hand-off intent', () => {
  it.each([
    'I am looking for a gift for my manager',
    'someone told me you sell baskets',
    'do you have something for the owner of a salon?',
    'my agent will collect it',
    'is the wallet suitable for staff uniforms?',
    'the owner said I can have it for $5',
    'Near the MTN mobile money agent',
    'a gift for my manager',
    'my manager wants two baskets',
    'our staff need 10 wallets',
    'I am the owner of a shop',
    'is someone at home for delivery',
    'can someone deliver it tomorrow',
    'my team loves your baskets',
    'do you sell to agents',
    'real leather or fake?',
    'is this a real person basket',
    'human hair wigs',
    'do you have human hair',
    'how much for the team pack',
    'the person I am buying for likes blue',
    'for a person who likes coffee',
    'staff discount?',
    'manager special price?',
    'who is the owner of this shop',
    'I want this for someone special',
    'buying for someone',
    'someone else will pay',
    'gift for a person',
    'agent commission',
    'do you have owner manuals',
    'I want to talk about the price',
    'can I talk about delivery',
    'let me talk to my wife first',
    'I need to speak to my husband',
    'my person will pick it up',
    'get me the basket',
    'give me the wallet',
    'send me the team photo',
    'send me a person size basket',
    'I need a big basket for my staff',
    'looking for a manager gift',
    'is there a discount',
    'can I get a basket',
    'can I have the wallet',
    'may I have a receipt',
    'call me maybe',
    'hi',
    'I want two',
  ])('%s does not ask for a person', (text) => {
    expect(wantsPerson(text)).toBe(false);
  });

  it.each([
    'human',
    'person',
    'a person',
    'real person',
    'agent',
    'someone',
    'owner',
    'manager',
    'talk to a person',
    'I want to talk to a person',
    'I want to speak to someone',
    'can I speak to the owner',
    'can I talk to a human',
    'talk to the team',
    'speak with the manager',
    'I need a real person',
    'I want a real person',
    'connect me to an agent',
    'get me a person',
    'put me through to the owner',
  ])('%s asks for a person', (text) => {
    expect(wantsPerson(text)).toBe(true);
  });

  it('understands the way back to the assistant', () => {
    for (const text of ['bot', 'Bot!', 'menu', 'back', 'go back', 'talk to the bot', 'assistant'])
      expect(wantsBot(text)).toBe(true);
    for (const text of ['hi', 'hello?', 'where is my order', 'back pain cream'])
      expect(wantsBot(text)).toBe(false);
  });
});

describe('delivery address', () => {
  it.each([
    'wait add another one',
    'wait',
    'actually add one more basket',
    'hold on a second please',
    'can I pay on delivery',
    'what is your return policy',
    'how much is delivery',
    'i want to change something',
    'sorry let me check',
    'no thanks not now',
    'yes please go ahead',
    'please remove the wallet',
    'remove the second one',
    'add two more wallets',
    'change the quantity',
    'also add a basket',
    'do you deliver to gulu?',
    'near where?',
    'thanks a lot',
    'ok',
    'ok thanks',
    'never mind then',
    'let me ask my husband',
    'tell me the total',
    'show me the cart',
    'give me a discount please',
    'maybe tomorrow morning',
    'because I am not sure',
    'hmm not sure yet',
    'send it later today',
    'cancel the order please',
    'the price is too high',
    'is it far from you',
    'are you open today',
    'when will it arrive',
    'I will send it later',
    "I'll tell you soon",
    'we are still deciding',
    'how about tomorrow',
    'one more please',
    'another one please',
    'make it three instead',
    'forget it for now',
    'just a moment please',
    'but I want red',
    'and the wallet too',
    'so what now then',
    'who delivers it',
    'why so expensive',
    'which one is cheaper',
  ])('%s is not an address', (text) => {
    expect(readAddress(text).kind).toBe('not_address');
  });

  it.each([
    'Plot 12 Kampala Road',
    'Near the MTN mobile money agent, Ntinda',
    'Ntinda, opposite Shell',
    'House 4, Kololo',
    'Acacia Mall Gate',
    'Kira Road near Mulago',
    'Bugolobi Village Mall',
    'P.O. Box 12 Entebbe',
    'No. 5 Acacia Avenue',
    'Block 3, Naalya Estate',
    'Muyenga, Tank Hill Road',
  ])('%s is an address', (text) => {
    expect(readAddress(text).kind).toBe('address');
  });

  it('reads address corrections', () => {
    expect(wantsAddressChange('change address')).toBe(true);
    expect(wantsAddressChange('Change my delivery address')).toBe(true);
    expect(wantsAddressChange('wrong address')).toBe(true);
    expect(wantsAddressChange('address')).toBe(false);
    expect(newAddressIn('change address to Plot 12 Kampala Road')).toBe('Plot 12 Kampala Road');
    expect(newAddressIn('deliver to Plot 9 Ntinda Road')).toBe('Plot 9 Ntinda Road');
    expect(newAddressIn('my address is Plot 3, Kololo')).toBe('Plot 3, Kololo');
    expect(newAddressIn('deliver it')).toBeNull();
    expect(wantsMethod('pick up instead')).toBe('PICKUP');
    expect(wantsMethod("I'll collect it")).toBe('PICKUP');
    expect(wantsMethod('delivery instead')).toBe('DELIVERY');
    expect(wantsMethod('how long is delivery')).toBeNull();
  });
});

describe('quantities and references', () => {
  it('reads more of the same', () => {
    expect(moreOfThis('wait add another one')).toBe(1);
    expect(moreOfThis('another one')).toBe(1);
    expect(moreOfThis('one more')).toBe(1);
    expect(moreOfThis('add two more')).toBe(2);
    expect(moreOfThis('3 more please')).toBe(3);
    expect(moreOfThis('add a basket')).toBeNull();
  });
  it('reads a new quantity only with intent words', () => {
    expect(newQuantity('make it three')).toBe(3);
    expect(newQuantity('Make it three instead')).toBe(3);
    expect(newQuantity('change it to 2')).toBe(2);
    expect(newQuantity('actually two')).toBe(2);
    expect(newQuantity('3')).toBeNull();
    expect(newQuantity('make it blue')).toBeNull();
  });
  it('reads price questions', () => {
    expect(asksPrice('How much is this?')).toBe(true);
    expect(asksPrice('what is the price')).toBe(true);
    expect(asksPrice('do you have it in blue')).toBe(false);
  });
});

describe('transcripts', () => {
  it.each(['Thank you for watching.', 'you', 'You.', '', '...', 'Thanks for watching!', 'Bye.'])(
    '%s is treated as noise',
    (text) => {
      expect(isLikelyHallucination(text)).toBe(true);
    },
  );
  it.each(['show me baskets', 'add two wallets', 'thank you for the basket'])(
    '%s is speech',
    (text) => {
      expect(isLikelyHallucination(text)).toBe(false);
    },
  );
});
