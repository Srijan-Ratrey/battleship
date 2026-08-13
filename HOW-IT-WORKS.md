# How this works — the simple version

Imagine you and a friend are playing a game of hide-the-ships. You each have a
big square of paper with 100 little boxes on it, like a chocolate bar.

You hide 5 ships on your paper. Your friend hides 5 ships on theirs. You are
**not allowed to see each other's paper**. That's the whole game.

Then you take turns guessing: *"Is there a ship in box B4?"* And the other person
has to say **"hit!"** or **"miss."**

Whoever sinks all the other person's ships first wins.

That's it. Everything below is just about how we made the computer do that.

---

## The referee in the middle

Here's the tricky bit. If you're both playing on your own computers, in different
houses, how do you stop someone from peeking?

So we put a **referee** in the middle. The referee sits in a little room and
holds **both** papers.

```
        You                  Referee                Your friend
         |                (holds BOTH papers)             |
         |  "is there a ship at B4?"                      |
         | ------------------------->                     |
         |                     (looks at their paper)     |
         |        "miss!"                                 |
         | <-------------------------                     |
         |                                                |
```

You never get to hold your friend's paper. You just get to **ask**, one box at a
time. And the referee only ever answers with one word: *hit* or *miss*.

That's the most important idea in the whole thing. **Your computer genuinely
does not know where your friend's ships are.** Not hidden, not greyed out — it
was never sent. So even a very clever cheater can't find out, because there's
nothing to find.

The only time the referee shows you both papers is at the very end, when the game
is over and there's nothing left to spoil.

---

## The room code

There are lots of people playing at once, so we need lots of referees.

When you start a game you get a little code, like **K7QF**. That's the name of
*your* referee. You send that code to your friend, they type it in, and they end
up in the same little room with the same referee.

Nobody else can wander in. Once two people are in a room, it's full.

---

## What if your computer falls asleep?

The referee is the one holding the papers — not you. So if your laptop shuts, or
your internet hiccups, or you close the tab by accident, **nothing is lost**. The
referee just sits there holding both papers, waiting.

When you come back, the referee says "oh good, you're back" and tells you
everything again: where your ships are, every box you've already guessed, and
whose turn it is. You carry on exactly where you stopped.

Your friend sees *"opponent reconnecting…"* while you're away, so they know you
haven't run off.

---

## Playing against the computer

If nobody's around, you can play against the computer instead. It's a robot that
sits in the second chair.

Here's the important part: **the robot doesn't get to peek either.** It sits on
the referee's side of the wall, but it's only ever handed the same thing you get
— its own list of "I guessed there, it was a miss." It has no way of seeing your
paper, because we never give it one.

We even test this. Sinking every ship takes exactly 17 good hits. So a robot that
was cheating would win in 17 guesses every time. We make it play 80 games and
check that it *never* wins that fast. It doesn't — because it can't.

There are two robots:

**Easy** just guesses anywhere at all, like closing your eyes and pointing. It
takes about **95 guesses** to win. You'll usually beat it.

**Hard** is cleverer, in two ways:

1. **It skips every other box while it's searching.** Think about it: the
   smallest ship covers 2 boxes in a row. So if you check every *other* box, you
   can't miss a ship — it has to be sitting on one of them. That's half as much
   work for the same result.

2. **When it gets a hit, it stops wandering and follows the ship.** It pokes
   right next to the hit. And once it gets two hits in a row, it knows which way
   the ship is lying, so it just keeps going that way until the ship sinks.

That takes about **52 guesses**. It'll often beat you.

The robot also waits about **three-quarters of a second** between shots. It
doesn't need to — it could fire instantly — but that feels horrible to play
against, like being shouted at. The pause makes it feel like someone thinking.

---

## A few small rules

- **Ships:** 5 of them, taking up 17 boxes altogether — one that's 5 long, one
  that's 4, two that are 3, and one that's 2.
- **Get a hit, go again.** Miss, and it's the other person's turn.
- **You're told which ship you sank**, but only when it actually sinks. Not
  before — otherwise you'd learn how big it was, which is cheating by accident.
- **Move your ships around** before you start by dragging them, or click one to
  spin it. The referee checks your arrangement is legal — no stacking ships on
  top of each other, no hanging them off the edge.

---

## Why we built it this way

Everything above comes from one decision: **the referee is the only one who
knows anything.**

It would honestly have been easier to send both papers to both computers and
just politely ask them not to look. Lots of games do that. But then the game
isn't really a game any more — it's a promise. This way it isn't a promise, it's
just how it works.

If you want the grown-up version with all the details, that's in
[README.md](README.md), and the reasons behind each choice are in
[battleship_decisions.md](battleship_decisions.md).
