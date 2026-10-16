//! Meters a WebAssembly module: an exported, mutable i64 global `naru_fuel`
//! is charged at every function entry and every loop iteration with the
//! number of instructions in that block, and the module traps (unreachable)
//! once it goes below zero. The host sets the fuel before a call.
use walrus::ir::*;
use walrus::{ConstExpr, FunctionBuilder, GlobalId, LocalFunction, Module, ValType};

fn seqs(func: &LocalFunction, id: InstrSeqId, entry: bool, out: &mut Vec<InstrSeqId>) {
    if entry {
        out.push(id);
    }
    for (instr, _) in &func.block(id).instrs {
        match instr {
            Instr::Block(Block { seq }) => seqs(func, *seq, false, out),
            Instr::Loop(Loop { seq }) => seqs(func, *seq, true, out),
            Instr::IfElse(IfElse { consequent, alternative }) => {
                seqs(func, *consequent, false, out);
                seqs(func, *alternative, false, out);
            }
            Instr::Try(_) | Instr::TryTable(_) => panic!("exception handling is not metered"),
            _ => {}
        }
    }
}

fn charge(builder: &mut FunctionBuilder, fuel: GlobalId, seq: InstrSeqId, cost: i64) {
    let trap = {
        let mut then = builder.dangling_instr_seq(None);
        then.unreachable();
        then.id()
    };
    let empty = builder.dangling_instr_seq(None).id();
    let check = vec![
        Instr::GlobalGet(GlobalGet { global: fuel }),
        Instr::Const(Const { value: Value::I64(cost) }),
        Instr::Binop(Binop { op: BinaryOp::I64Sub }),
        Instr::GlobalSet(GlobalSet { global: fuel }),
        Instr::GlobalGet(GlobalGet { global: fuel }),
        Instr::Const(Const { value: Value::I64(0) }),
        Instr::Binop(Binop { op: BinaryOp::I64LtS }),
        Instr::IfElse(IfElse { consequent: trap, alternative: empty }),
    ];
    let mut block = builder.instr_seq(seq);
    for (i, instr) in check.into_iter().enumerate() {
        block.instr_at(i, instr);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut module = Module::from_file(&args[1]).expect("parse");
    let fuel = module.globals.add_local(ValType::I64, true, false, ConstExpr::Value(Value::I64(i64::MAX)));
    module.exports.add("naru_fuel", fuel);
    for (_, func) in module.funcs.iter_local_mut() {
        let mut found = Vec::new();
        seqs(func, func.entry_block(), true, &mut found);
        for seq in found {
            let cost = func.block(seq).instrs.len().max(1) as i64;
            charge(func.builder_mut(), fuel, seq, cost);
        }
    }
    module.emit_wasm_file(&args[2]).expect("emit");
}
